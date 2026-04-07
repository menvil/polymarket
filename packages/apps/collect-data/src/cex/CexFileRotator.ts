/**
 * CexFileRotator — ротация файлов по 5-минутным UTC-окнам.
 *
 * @remarks
 * ### Назначение:
 * Записывает события (ордербуки и трейды) в файлы с ротацией по
 * округлённым UTC-границам (00:00, 00:05, 00:10, ...).
 *
 * ### Жизненный цикл файла:
 * ```
 * Старт в 12:03
 *   → подписка к ccxt уже идёт, данные принимаем, НЕ пишем в файл
 *   → ждём 12:05 (выравнивание по границе окна)
 *
 * 12:05 → открываем BTC-USDT__1205.jsonl, начинаем запись
 * 12:10 → закрываем, gzip → BTC-USDT__1205.jsonl.gz
 *       → открываем BTC-USDT__1210.jsonl
 *
 * SIGINT в 12:13 (незавершённое окно)
 *   → закрываем стримы, удаляем BTC-USDT__1210.jsonl
 * ```
 *
 * ### Формат файлов:
 * ```
 * data/2026-04-06/binance/BTC-USDT__1200.jsonl.gz  ← завершённые
 * data/2026-04-06/binance/BTC-USDT__1205.jsonl     ← текущий (in-progress)
 * ```
 *
 * ### Формат записей:
 * ```json
 * {"t":"ob","ts":1712401200000,"bids":[[64999.5,1.2]],"asks":[[65000.0,0.5]]}
 * {"t":"trade","ts":1712401200123,"p":65000.0,"sz":0.15,"side":"buy"}
 * ```
 * Exchange и symbol закодированы в имени файла — в записях не дублируются.
 *
 * @example
 * ```typescript
 * const rotator = new CexFileRotator({ outputDir, compression: 'gzip', windowMinutes: 5 }, logger);
 * rotator.start();
 * rotator.write('binance', 'BTC/USDT', 'spot', { t: 'ob', ts: Date.now(), bids: [...], asks: [...] });
 * await rotator.close();
 * ```
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { ILogger } from '@polymarket/logger';

/** Конфигурация ротатора */
export interface CexFileRotatorConfig {
  readonly outputDir: string;
  readonly compression: 'none' | 'gzip';
  readonly windowMinutes?: number;
  readonly bufferSize?: number;
  readonly flushIntervalMs?: number;
}

/** Буферизированная запись с отформатированной строкой */
interface BufferedLine {
  readonly line: string;
}

/** Состояние писателя для одного ключа exchange+symbol */
interface SymbolWriter {
  readonly filePath: string;
  buffer: BufferedLine[];
  stream: fs.WriteStream | null;
  eventsWritten: number;
}

/**
 * Ротатор файлов CEX данных по 5-минутным UTC-окнам.
 */
export class CexFileRotator {
  private readonly _windowMs: number;
  private readonly _bufferSize: number;
  private readonly _flushIntervalMs: number;

  /** Текущее начало окна (Unix ms, кратно windowMs) */
  private _windowStart = 0;
  /** true когда прошла первая граница — начинаем записывать */
  private _active = false;

  /** Map: `${exchange}__${safeSymbol}` → SymbolWriter */
  private readonly _writers = new Map<string, SymbolWriter>();

  private _rotationTimer: ReturnType<typeof setTimeout> | null = null;
  private _flushTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param _config - Конфигурация ротатора
   * @param _logger - Логгер
   */
  constructor(
    private readonly _config: CexFileRotatorConfig,
    private readonly _logger: ILogger,
  ) {
    this._windowMs = ((_config.windowMinutes ?? 5) * 60 * 1000);
    this._bufferSize = _config.bufferSize ?? 200;
    this._flushIntervalMs = _config.flushIntervalMs ?? 5_000;
  }

  /**
   * Запускает ротатор: вычисляет следующую границу окна, планирует таймеры.
   *
   * @remarks
   * До первой границы данные принимаются через `write()` но не записываются на диск.
   * WS-соединения при этом уже активны — данные дойдут сразу с первой границы.
   */
  public start(): void {
    const now = Date.now();
    const nextBoundary = this._nextBoundary(now);
    const delay = nextBoundary - now;

    this._logger.info('CexFileRotator started — waiting for alignment', {
      nextWindowUTC: new Date(nextBoundary).toISOString(),
      delayMs: delay,
    });

    this._rotationTimer = setTimeout(() => {
      this._windowStart = nextBoundary;
      this._active = true;
      this._logger.info('CexFileRotator aligned — recording started', {
        windowUTC: new Date(nextBoundary).toISOString(),
      });
      this._scheduleNextRotation();
    }, delay);

    this._flushTimer = setInterval(() => {
      void this._flushAll();
    }, this._flushIntervalMs);

    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  /**
   * Записывает событие в буфер текущего окна.
   *
   * @param exchange - ID биржи (например `'binance'`)
   * @param symbol - Символ в формате ccxt (например `'BTC/USDT'`)
   * @param marketType - Тип рынка (`'spot'`, `'futures'`, `'swap'`)
   * @param record - Объект события (ob или trade)
   *
   * @remarks
   * Игнорирует вызовы до выравнивания по первой границе окна.
   * O(1) — поиск писателя по Map.
   */
  public write(exchange: string, symbol: string, marketType: string, record: object): void {
    if (!this._active) return;

    const key = this._makeKey(exchange, symbol, marketType);
    let writer = this._writers.get(key);

    if (!writer) {
      writer = this._createWriter(exchange, symbol, marketType);
      this._writers.set(key, writer);
    }

    const line = JSON.stringify(record) + '\n';
    writer.buffer.push({ line });
    writer.eventsWritten++;

    if (writer.buffer.length >= this._bufferSize) {
      void this._flushWriter(writer);
    }
  }

  /**
   * Удаляет незавершённые `.jsonl` файлы от предыдущего краш-запуска.
   *
   * @param exchangeIds - Список ID бирж из конфига (сканируем только их папки)
   *
   * @remarks
   * Вызывается при старте — до первого `write()`. Поэтому любой `.jsonl`
   * файл в папках бирж гарантированно от упавшего прошлого запуска.
   *
   * `.jsonl.gz` не трогаются — завершённые архивы.
   *
   * ⚠️ Не запускать два коллектора с одинаковым `outputDir`.
   *
   * @example
   * ```typescript
   * await rotator.cleanup(['binance', 'okx']);
   * rotator.start();
   * ```
   */
  public async cleanup(exchangeIds: string[]): Promise<void> {
    if (!fs.existsSync(this._config.outputDir)) return;

    let dateDirs: fs.Dirent[];
    try {
      dateDirs = await fs.promises.readdir(this._config.outputDir, { withFileTypes: true });
    } catch {
      return;
    }

    let deleted = 0;
    for (const dateEntry of dateDirs) {
      if (!dateEntry.isDirectory()) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;

      for (const exchangeId of exchangeIds) {
        const exchangeDir = path.join(this._config.outputDir, dateEntry.name, exchangeId);
        if (!fs.existsSync(exchangeDir)) continue;

        let files: fs.Dirent[];
        try {
          files = await fs.promises.readdir(exchangeDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const file of files) {
          if (!file.isFile()) continue;
          if (file.name.endsWith('.jsonl') && !file.name.endsWith('.jsonl.gz')) {
            try {
              await fs.promises.unlink(path.join(exchangeDir, file.name));
              deleted++;
            } catch {
              // ignore
            }
          }
        }
      }
    }

    if (deleted > 0) {
      this._logger.info('CexFileRotator: cleaned up incomplete files from previous crash', {
        deleted,
        exchanges: exchangeIds,
      });
    }
  }

  /**
   * Останавливает ротатор, удаляет незавершённые файлы текущего окна.
   *
   * @remarks
   * Незавершённые `.jsonl` файлы (без gzip) — неполные данные, удаляем.
   * Завершённые `.jsonl.gz` файлы уже записаны, не трогаем.
   */
  public async close(): Promise<void> {
    this._logger.info('CexFileRotator closing — deleting incomplete window files');

    if (this._rotationTimer) {
      clearTimeout(this._rotationTimer);
      this._rotationTimer = null;
    }
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }

    this._active = false;

    // При close (shutdown) файлы всё равно удаляются — не ждём drain, сразу destroy.
    // Это предотвращает зависание если стрим находится в errored-состоянии.
    let deleted = 0;
    for (const writer of this._writers.values()) {
      try { writer.stream?.destroy(); } catch { /* ignore */ }
      writer.stream = null;

      try {
        if (fs.existsSync(writer.filePath)) {
          await fs.promises.unlink(writer.filePath);
          deleted++;
        }
      } catch (err) {
        this._logger.warn('Failed to delete incomplete CEX file', {
          filePath: writer.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this._writers.clear();

    this._logger.info('CexFileRotator closed', { deletedFiles: deleted });
  }

  // ── Приватные методы ──────────────────────────────────────────────────────

  /**
   * Планирует следующую ротацию точно на границу окна.
   */
  private _scheduleNextRotation(): void {
    const nextBoundary = this._windowStart + this._windowMs;
    const delay = nextBoundary - Date.now();

    this._rotationTimer = setTimeout(() => {
      void this._rotate(nextBoundary);
    }, Math.max(0, delay));
  }

  /**
   * Выполняет ротацию: закрывает текущее окно, открывает следующее.
   *
   * @param newWindowStart - Начало нового окна (Unix ms)
   */
  private async _rotate(newWindowStart: number): Promise<void> {
    const oldWindowStart = this._windowStart;
    this._logger.info('Rotating CEX window', {
      closedWindowUTC: new Date(oldWindowStart).toISOString(),
      newWindowUTC: new Date(newWindowStart).toISOString(),
      activeSymbols: this._writers.size,
    });

    // Флашим и закрываем текущие стримы
    await this._flushAll();
    await this._closeAllStreams();

    // Сжимаем завершённые файлы
    if (this._config.compression === 'gzip') {
      await this._gzipAllCurrentFiles();
    }

    // Обновляем состояние на новое окно — старые писатели больше не нужны
    this._windowStart = newWindowStart;
    this._writers.clear();

    this._logger.info('CEX window rotation complete', {
      newWindowUTC: new Date(newWindowStart).toISOString(),
    });

    this._scheduleNextRotation();
  }

  /**
   * Сжимает все текущие `.jsonl` файлы в `.jsonl.gz`.
   */
  private async _gzipAllCurrentFiles(): Promise<void> {
    const tasks = [...this._writers.values()].map(async (writer) => {
      const src = writer.filePath;
      const dst = src + '.gz';

      if (!fs.existsSync(src)) return;

      try {
        await pipeline(
          fs.createReadStream(src),
          zlib.createGzip(),
          fs.createWriteStream(dst),
        );
        await fs.promises.unlink(src);
        this._logger.debug('CEX file compressed', { src, dst });
      } catch (err) {
        this._logger.warn('Failed to gzip CEX file', {
          src,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    await Promise.all(tasks);
  }

  /**
   * Создаёт нового SymbolWriter для текущего окна.
   *
   * @param exchange - ID биржи
   * @param symbol - Символ ccxt
   * @param marketType - Тип рынка
   * @returns Новый SymbolWriter с открытым WriteStream
   */
  private _createWriter(exchange: string, symbol: string, marketType: string): SymbolWriter {
    const filePath = this._buildFilePath(exchange, symbol, marketType, this._windowStart);

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      // Удаляем если остался от предыдущего незавершённого запуска
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this._logger.warn('Deleted leftover incomplete CEX file from previous run', { filePath });
      }

      const stream = fs.createWriteStream(filePath, { flags: 'a' });
      stream.on('error', (err) => {
        this._logger.error('CEX write stream error', { filePath, error: err.message });
      });

      const writer: SymbolWriter = {
        filePath,
        buffer: [],
        stream,
        eventsWritten: 0,
      };

      this._logger.debug('CEX writer opened', { exchange, symbol, filePath });
      return writer;
    } catch (err) {
      throw new Error(`Failed to create CEX writer for ${exchange}/${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Сбрасывает буфер одного писателя на диск.
   *
   * @param writer - Писатель
   */
  private async _flushWriter(writer: SymbolWriter): Promise<void> {
    if (writer.buffer.length === 0 || !writer.stream) return;

    const data = writer.buffer.map((b) => b.line).join('');
    writer.buffer = [];

    const canContinue = writer.stream.write(data, (err) => {
      if (err) this._logger.error('CEX stream write error', { error: err.message });
    });

    if (!canContinue) {
      await new Promise<void>((resolve) => writer.stream!.once('drain', resolve));
    }
  }

  /**
   * Сбрасывает буферы всех активных писателей.
   */
  private async _flushAll(): Promise<void> {
    await Promise.all([...this._writers.values()].map((w) => this._flushWriter(w)));
  }

  /**
   * Закрывает все WriteStream'ы.
   *
   * @remarks
   * Всегда резолвит — никогда не реджектит.
   * Ошибка закрытия отдельного стрима не должна ломать весь shutdown.
   */
  private async _closeAllStreams(): Promise<void> {
    await Promise.all(
      [...this._writers.values()].map(
        (writer) =>
          new Promise<void>((resolve) => {
            if (!writer.stream) {
              resolve();
              return;
            }
            writer.stream.end((err?: Error | null) => {
              if (err) {
                this._logger.warn('Failed to close CEX write stream', {
                  filePath: writer.filePath,
                  error: err.message,
                });
              }
              resolve(); // всегда resolve — ошибка не ломает shutdown
            });
            writer.stream = null;
          }),
      ),
    );
  }

  /**
   * Строит путь к файлу для текущего окна.
   *
   * @param exchange - ID биржи (например `'binance'`)
   * @param symbol - Символ ccxt (например `'BTC/USDT'`)
   * @param marketType - Тип рынка (например `'spot'`, `'futures'`)
   * @param windowStart - Начало окна (Unix ms)
   * @returns Путь: `outputDir/YYYY-MM-DD/{exchange}/{exchange}_{safeSymbol}_{marketType}_{YYYY-MonthName-DD}_{HMMam}-{HMMam}_ET.jsonl`
   *
   * @example
   * ```typescript
   * // windowStart = 2026-04-06 02:30 ET, type = 'spot'
   * // → 'snapshots/2026-04-06/binance/binance_BTC-USDT_spot_2026-April-06_230AM-235AM_ET.jsonl'
   * ```
   */
  private _buildFilePath(exchange: string, symbol: string, marketType: string, windowStart: number): string {
    const utcDate    = new Date(windowStart).toISOString().slice(0, 10); // YYYY-MM-DD (UTC, для директории)
    const windowEnd  = windowStart + this._windowMs;
    const dateLabel  = this._formatDateET(windowStart);  // "2026-April-06"
    const startLabel = this._formatTimeET(windowStart);  // "230AM"
    const endLabel   = this._formatTimeET(windowEnd);    // "235AM"
    const safeSymbol = symbol.replace('/', '-');          // BTC/USDT → BTC-USDT
    const fileName   = `${exchange}_${safeSymbol}_${marketType}_${dateLabel}_${startLabel}-${endLabel}_ET.jsonl`;
    return path.join(this._config.outputDir, utcDate, exchange, fileName);
  }

  /**
   * Форматирует дату в ET-таймзоне как `YYYY-MonthName-DD`.
   *
   * @param ms - Unix ms
   * @returns Строка вида `'2026-April-06'`
   */
  private _formatDateET(ms: number): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: 'long',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const year  = parts.find((p) => p.type === 'year')!.value;
    const month = parts.find((p) => p.type === 'month')!.value; // "April"
    const day   = parts.find((p) => p.type === 'day')!.value;   // "06"
    return `${year}-${month}-${day}`;
  }

  /**
   * Форматирует время в ET-таймзоне как `HMMam` (без разделителей).
   *
   * @param ms - Unix ms
   * @returns Строка вида `'230AM'`, `'1205PM'`, `'1200AM'`
   */
  private _formatTimeET(ms: number): string {
    // Intl даёт "2:30 AM" или "12:05 PM"
    const raw = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(ms));
    // "2:30 AM" → "230AM", "12:05 PM" → "1205PM"
    return raw.replace(':', '').replace(' ', '');
  }

  /**
   * Вычисляет следующую границу окна после `now`.
   *
   * @param now - Текущее время (Unix ms)
   * @returns Следующая кратная windowMs граница
   */
  private _nextBoundary(now: number): number {
    return (Math.floor(now / this._windowMs) + 1) * this._windowMs;
  }

  /**
   * Строит ключ Map для писателя.
   *
   * @param exchange - ID биржи
   * @param symbol - Символ ccxt
   * @param marketType - Тип рынка
   * @returns Строка вида `'binance__BTC-USDT__spot'`
   */
  private _makeKey(exchange: string, symbol: string, marketType: string): string {
    return `${exchange}__${symbol.replace('/', '-')}__${marketType}`;
  }
}
