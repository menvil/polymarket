/**
 * CexWindowRecorder — оконная (time-window) storage-policy CEX-партиций.
 *
 * @remarks
 * ### Место в архитектуре (N-005)
 *
 * ```text
 * CexSource → ExternalMessage → общий ExternalMessageBus
 *                                       ↓ subscribe('CEX_*')
 *                          ExternalMessageRecorder (ONE service)
 *                              ↙                       ↘
 *                    DataRecorder                CexWindowRecorder (этот класс)
 *                    market-session policy       time-window policy
 *                        ↓                            ↓
 *                    market JSONL.gz             оконные JSONL.gz
 * ```
 *
 * Один Recorder-СЕРВИС — несколько storage/writer-policy: жизненный цикл
 * CEX-партиции (непрерывный поток → выровненное окно → ротация → gzip)
 * принципиально отличается от market-session lifecycle Polymarket
 * (OPEN → SEAL → enrichment → FINALIZE), поэтому это ОТДЕЛЬНЫЙ движок, а
 * не абстракция над обоими (evidence-based решение N-005 PART 18; общая
 * механика переиспользуется точечно — {@link GzipCompressor}).
 *
 * ### Сохранённый behavioral contract legacy `CexFileRotator`
 *
 * - выровненные временные окна (production default — 5 минут);
 * - запись начинается только с ПЕРВОЙ границы окна после `start()`
 *   (записи до выравнивания сознательно отбрасываются — каждая завершённая
 *   партиция покрывает ПОЛНОЕ окно);
 * - множественные независимые writer-ы;
 * - буферизация строк (default 200) + периодический flush (default 5s);
 * - gzip завершённого окна; `.jsonl` = незавершённый, `.jsonl.gz` =
 *   завершённый;
 * - cleanup незавершённых файлов при старте и close;
 * - детерминированное naming (см. ниже).
 *
 * ### Отличия от legacy (осознанные)
 *
 * 1. **Routing-ключ включает stream** (`orderbook`/`trades`): legacy писал
 *    оба типа записей в один файл, различая их полем `t` — V2 персистит
 *    payload-only строки БЕЗ нашего дискриминатора, поэтому тип потока
 *    обязан жить в ключе партиции и имени файла.
 * 2. **Окно назначается в момент записи** (write-time assignment):
 *    у legacy записи, пришедшие во время асинхронной ротации (gzip),
 *    попадали в буфер уже закрытого writer-а и терялись. Здесь запись
 *    всегда попадает в writer СВОЕГО окна: границу окна определяет clock,
 *    а не момент срабатывания rotation-таймера.
 * 3. **Символ в имени файла санитизируется** по `[/:]` (swap-символы CCXT
 *    вида `BTC/USDT:USDT`), routing-ключ использует сырой символ.
 *
 * ### Схема именования
 *
 * ```text
 * {outputDir}/{utcDate}/{exchange}/
 *   {exchange}_{symbol}_{marketType}_{stream}_{dateET}_{startET}-{endET}_ET.jsonl[.gz]
 * ```
 *
 * Пример:
 * `snapshots/2026-08-25/binance/binance_BTC-USDT-USDT_swap_orderbook_2026-August-25_0955AM-1000AM_ET.jsonl.gz`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ILogger } from '@polymarket/logger';
import { GzipCompressor } from './compression/GzipCompressor.js';

/** Тип потока CEX-партиции (часть routing-ключа и имени файла). */
export type CexStreamKind = 'orderbook' | 'trades';

/**
 * Исход записи одной строки через {@link CexWindowRecorder.write}.
 *
 * - `'recorded'` — строка сериализована и поставлена в буфер окна;
 * - `'inactive'` — запись сознательно отброшена (до первой границы окна
 *   либо после close) — это policy, а не ошибка;
 * - `'failed'` — запись невозможна и это ошибка (залогирована):
 *   сериализация payload либо разрушенный stream.
 */
export type CexWindowRecordOutcome = 'recorded' | 'inactive' | 'failed';

/**
 * Конфигурация {@link CexWindowRecorder}.
 */
export interface CexWindowRecorderConfig {
  /** Директория партиций (создаётся автоматически). */
  readonly outputDir: string;
  /** Сжатие завершённого окна: `gzip` → `.jsonl.gz`, `none` → `.jsonl` остаётся. */
  readonly compression: 'none' | 'gzip';
  /**
   * Длина окна (минуты). Production default: 5.
   * Дробные значения допустимы ТОЛЬКО для тестов/smoke (короткие окна);
   * production-значение не меняется ради них.
   */
  readonly windowMinutes?: number;
  /** Максимальный буфер строк одного writer-а перед flush. Default: 200. */
  readonly bufferSize?: number;
  /** Интервал периодического flush (ms). Default: 5000. */
  readonly flushIntervalMs?: number;
}

/** Состояние одного оконного writer-а. */
interface WindowWriter {
  /** Routing-ключ (exchange+symbol+marketType+stream). */
  readonly routingKey: string;
  /** Начало окна writer-а (Unix ms, выровнено). */
  readonly windowStart: number;
  /** Полный путь текущего `.jsonl`. */
  readonly filePath: string;
  buffer: string[];
  stream: fs.WriteStream | null;
  linesAccepted: number;
  /** true после ошибки stream — строки далее не принимаются. */
  failed: boolean;
}

const DEFAULT_WINDOW_MINUTES = 5;
const DEFAULT_BUFFER_SIZE = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const CLOSE_STREAM_TIMEOUT_MS = 5_000;

/**
 * Оконный storage-движок CEX-партиций: буферизация, ротация по границе
 * окна, gzip, cleanup.
 *
 * @remarks
 * ### Lifecycle
 *
 * ```text
 * cleanup() (опционально, при старте процесса)
 * start()   → выравнивание по границе окна → приём записей
 * write()   → буфер окна (flush по threshold/таймеру)
 * [граница] → ротация: flush → close stream → gzip → партиция завершена
 * close()   → таймеры сняты, in-flight ротации дождались, незавершённые
 *             .jsonl текущих окон удалены
 * ```
 *
 * Потокобезопасность — single-threaded Node.js.
 *
 * @example
 * ```typescript
 * const storage = new CexWindowRecorder(
 *   { outputDir: './cex-snapshots', compression: 'gzip' },
 *   logger,
 * );
 * await storage.cleanup();
 * storage.start();
 * storage.write('binance', 'BTC/USDT:USDT', 'swap', 'orderbook', payload);
 * // ... shutdown:
 * await storage.close();
 * ```
 */
export class CexWindowRecorder {
  private readonly _logger: ILogger;
  private readonly _windowMs: number;
  private readonly _bufferSize: number;
  private readonly _flushIntervalMs: number;
  private readonly _compressor: GzipCompressor | null;
  private readonly _outputDir: string;
  /** Источник времени (инъецируем в тестах для детерминизма окон). */
  private readonly _now: () => number;

  /** Активные writer-ы: routingKey → writer ТЕКУЩЕГО окна ключа. */
  private readonly _writers = new Map<string, WindowWriter>();
  /** In-flight ротации (gzip): close() дожидается их завершения. */
  private readonly _pendingRotations = new Set<Promise<void>>();
  private _boundaryTimer: ReturnType<typeof setTimeout> | null = null;
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Первая граница, с которой принимаются записи (полные окна). */
  private _firstWindowStart = Number.POSITIVE_INFINITY;
  private _started = false;
  private _closed = false;
  private _closePromise: Promise<void> | null = null;

  /**
   * @param config - Конфигурация оконной политики
   * @param logger - Логгер (будет обёрнут в child с component-контекстом)
   * @param now - @internal Test hook: источник времени. Default: `Date.now`
   */
  constructor(
    config: CexWindowRecorderConfig,
    logger: ILogger,
    now: () => number = Date.now,
  ) {
    this._logger = logger.child({ component: 'CexWindowRecorder' });
    this._windowMs = Math.max(1, Math.round((config.windowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60_000));
    this._bufferSize = config.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this._flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this._compressor = config.compression === 'gzip' ? new GzipCompressor() : null;
    this._now = now;
    this._outputDir = config.outputDir;
  }

  /** true после {@link CexWindowRecorder.close}. */
  public get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Запускает оконную политику: приём записей начнётся с ПЕРВОЙ границы
   * окна после вызова (записи до выравнивания отбрасываются как `inactive`).
   *
   * @remarks
   * Идемпотентен. Параллельно запускает периодический flush-таймер и
   * boundary-таймер ротации «тихих» writer-ов (окна без новых записей
   * завершаются по границе, а не ждут следующей записи своего ключа).
   */
  public start(): void {
    if (this._started || this._closed) {
      return;
    }
    this._started = true;
    const now = this._now();
    this._firstWindowStart = this._nextBoundary(now);

    this._logger.info('CexWindowRecorder started, waiting for window alignment', {
      firstWindowUTC: new Date(this._firstWindowStart).toISOString(),
      delayMs: this._firstWindowStart - now,
      windowMs: this._windowMs,
    });

    this._scheduleBoundarySweep();
    this._flushTimer = setInterval(() => {
      void this._flushAll();
    }, this._flushIntervalMs);
    this._flushTimer.unref?.();
  }

  /**
   * Записывает payload-строку в партицию окна (payload-only инвариант:
   * сериализуется РОВНО переданный payload, без envelope-полей).
   *
   * @param exchangeId - Идентификатор биржи (routing)
   * @param symbol - Сырой unified-символ (routing; в имени файла
   *   санитизируется)
   * @param marketType - Тип рынка (routing)
   * @param stream - Тип потока (routing: партиции стакана и сделок раздельны)
   * @param payload - Source-native payload сообщения (JSON-сериализуемый)
   * @returns Исход записи (см. {@link CexWindowRecordOutcome})
   *
   * @remarks
   * Окно назначается по ТЕКУЩЕМУ времени записи: запись, пришедшая во
   * время асинхронной ротации предыдущего окна, попадает в writer нового
   * окна (у legacy такие строки терялись в буфере закрытого writer-а).
   */
  public write(
    exchangeId: string,
    symbol: string,
    marketType: string,
    stream: CexStreamKind,
    payload: unknown,
  ): CexWindowRecordOutcome {
    if (this._closed || !this._started) {
      return 'inactive';
    }
    const now = this._now();
    const windowStart = this._windowStartOf(now);
    if (windowStart < this._firstWindowStart) {
      return 'inactive';
    }

    let line: string;
    try {
      line = `${JSON.stringify(payload)}\n`;
    } catch (error) {
      this._logger.error('Failed to serialize CEX payload line', {
        exchangeId,
        symbol,
        stream,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }

    const routingKey = this._routingKey(exchangeId, symbol, marketType, stream);
    let writer = this._writers.get(routingKey);
    if (writer && writer.windowStart !== windowStart) {
      // Ключ пересёк границу: прежнее окно уходит в ротацию, новое — сразу
      // принимает запись (без гонки с асинхронным gzip)
      this._writers.delete(routingKey);
      this._trackRotation(this._rotateWriter(writer));
      writer = undefined;
    }
    if (!writer) {
      try {
        writer = this._createWriter(routingKey, exchangeId, symbol, marketType, stream, windowStart);
      } catch (error) {
        this._logger.error('Failed to open CEX window writer', {
          exchangeId,
          symbol,
          stream,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'failed';
      }
      this._writers.set(routingKey, writer);
    }
    if (writer.failed || !writer.stream) {
      return 'failed';
    }

    writer.buffer.push(line);
    writer.linesAccepted++;
    if (writer.buffer.length >= this._bufferSize) {
      void this._flushWriter(writer);
    }
    return 'recorded';
  }

  /**
   * Принудительный flush всех буферов на диск.
   *
   * @returns Promise завершения записи буферов
   */
  public async flush(): Promise<void> {
    await this._flushAll();
  }

  /**
   * Удаляет незавершённые `.jsonl` (без `.gz`) из датированных директорий.
   *
   * @returns Promise завершения очистки
   *
   * @remarks
   * Вызывается при старте процесса: остатки прошлого некорректно
   * завершённого запуска (незавершённые окна) не подлежат восстановлению —
   * семантика `.jsonl` = incomplete сохранена из legacy. Завершённые
   * `.jsonl.gz` не трогаются.
   */
  public async cleanup(): Promise<void> {
    let dateDirs: fs.Dirent[];
    try {
      dateDirs = await fs.promises.readdir(this._outputDir, { withFileTypes: true });
    } catch {
      return; // директории ещё нет — чистить нечего
    }

    let deleted = 0;
    for (const dateEntry of dateDirs) {
      if (!dateEntry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;
      const dateDir = path.join(this._outputDir, dateEntry.name);

      let exchangeDirs: fs.Dirent[];
      try {
        exchangeDirs = await fs.promises.readdir(dateDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const exchangeEntry of exchangeDirs) {
        if (!exchangeEntry.isDirectory()) continue;
        const exchangeDir = path.join(dateDir, exchangeEntry.name);

        let files: fs.Dirent[];
        try {
          files = await fs.promises.readdir(exchangeDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const file of files) {
          if (!file.isFile()) continue;
          if (!file.name.endsWith('.jsonl') || file.name.endsWith('.jsonl.gz')) continue;
          try {
            await fs.promises.unlink(path.join(exchangeDir, file.name));
            deleted++;
          } catch {
            // Файл мог исчезнуть параллельно — cleanup best-effort
          }
        }
      }
    }

    if (deleted > 0) {
      this._logger.info('CexWindowRecorder cleaned up incomplete files', { deleted });
    }
  }

  /**
   * Останавливает политику: таймеры сняты, in-flight ротации дождались,
   * незавершённые файлы текущих окон удалены.
   *
   * @returns Promise завершения shutdown (идемпотентен)
   *
   * @remarks
   * Незавершённое окно НЕ архивируется: его данные не покрывают полное
   * окно (семантика legacy). Уже завершённые `.jsonl.gz` не трогаются.
   */
  public async close(): Promise<void> {
    if (this._closePromise) {
      return this._closePromise;
    }
    this._closed = true;
    if (this._boundaryTimer) {
      clearTimeout(this._boundaryTimer);
      this._boundaryTimer = null;
    }
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }

    const writersSnapshot = [...this._writers.values()];
    this._writers.clear();

    this._closePromise = (async () => {
      // Сначала дожидаемся ротаций, начатых ДО close: их партиции завершены
      // легитимно и должны быть сжаты
      await Promise.allSettled([...this._pendingRotations]);

      // Незавершённые окна: stream разрушается, файл удаляется
      await Promise.all(
        writersSnapshot.map(async (writer) => {
          await this._destroyStream(writer);
          try {
            await fs.promises.unlink(writer.filePath);
          } catch {
            // Файл мог не существовать (writer без единого flush)
          }
        }),
      );
      this._logger.info('CexWindowRecorder closed', {
        deletedIncomplete: writersSnapshot.length,
      });
    })();
    return this._closePromise;
  }

  // ───────────────────────── Ротация окон ─────────────────────────

  /** Планирует sweep «тихих» writer-ов на следующей границе окна. */
  private _scheduleBoundarySweep(): void {
    if (this._closed) return;
    const now = this._now();
    const delay = Math.max(0, this._nextBoundary(now) - now);
    this._boundaryTimer = setTimeout(() => {
      this._sweepExpiredWindows();
      this._scheduleBoundarySweep();
    }, delay);
    this._boundaryTimer.unref?.();
  }

  /** Ротирует все writer-ы, чьё окно уже закончилось (без новых записей). */
  private _sweepExpiredWindows(): void {
    const currentWindow = this._windowStartOf(this._now());
    for (const [routingKey, writer] of [...this._writers]) {
      if (writer.windowStart < currentWindow) {
        this._writers.delete(routingKey);
        this._trackRotation(this._rotateWriter(writer));
      }
    }
  }

  /** Регистрирует in-flight ротацию (close() дожидается). */
  private _trackRotation(rotation: Promise<void>): void {
    const tracked = rotation.finally(() => {
      this._pendingRotations.delete(tracked);
    });
    this._pendingRotations.add(tracked);
  }

  /**
   * Завершает окно writer-а: flush → close stream → gzip.
   *
   * @param writer - Writer завершённого окна (уже удалён из map)
   */
  private async _rotateWriter(writer: WindowWriter): Promise<void> {
    await this._flushWriter(writer);
    await this._endStream(writer);

    if (this._compressor && !writer.failed) {
      try {
        await this._compressor.compressFile(writer.filePath);
        this._logger.debug('CEX window partition compressed', { filePath: writer.filePath });
      } catch (error) {
        this._logger.warn('Failed to gzip CEX window partition', {
          filePath: writer.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this._logger.info('CEX window partition completed', {
      filePath: writer.filePath,
      lines: writer.linesAccepted,
      windowUTC: new Date(writer.windowStart).toISOString(),
    });
  }

  // ───────────────────────── Writer-ы и запись ─────────────────────────

  private _createWriter(
    routingKey: string,
    exchangeId: string,
    symbol: string,
    marketType: string,
    stream: CexStreamKind,
    windowStart: number,
  ): WindowWriter {
    const filePath = this._buildFilePath(exchangeId, symbol, marketType, stream, windowStart);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this._logger.warn('Deleted leftover incomplete CEX window file', { filePath });
    }

    const writer: WindowWriter = {
      routingKey,
      windowStart,
      filePath,
      buffer: [],
      stream: fs.createWriteStream(filePath, { flags: 'a' }),
      linesAccepted: 0,
      failed: false,
    };
    writer.stream!.on('error', (error) => {
      writer.failed = true;
      this._logger.error('CEX window stream error', { filePath, error: error.message });
    });

    this._logger.debug('CEX window writer opened', { filePath });
    return writer;
  }

  /**
   * Пишет буфер writer-а в stream.
   *
   * @remarks
   * Дожидается write-callback-а (данные переданы ОС): после `flush()`
   * содержимое наблюдаемо на диске — контракт нужен ротации (gzip читает
   * файл сразу после flush) и детерминизму shutdown.
   */
  private async _flushWriter(writer: WindowWriter): Promise<void> {
    if (writer.buffer.length === 0 || !writer.stream || writer.failed) return;

    const data = writer.buffer.join('');
    writer.buffer = [];

    const stream = writer.stream;
    await new Promise<void>((resolve) => {
      stream.write(data, (error) => {
        if (error) {
          writer.failed = true;
          this._logger.error('CEX window stream write error', {
            filePath: writer.filePath,
            error: error.message,
          });
        }
        resolve();
      });
    });
  }

  private async _flushAll(): Promise<void> {
    await Promise.all([...this._writers.values()].map((writer) => this._flushWriter(writer)));
  }

  /** Корректно завершает stream writer-а (`end`, дожидаясь finish). */
  private async _endStream(writer: WindowWriter): Promise<void> {
    const stream = writer.stream;
    if (!stream) return;
    writer.stream = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_STREAM_TIMEOUT_MS);
      timer.unref?.();
      stream.end(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Разрушает stream writer-а без дозаписи (файл будет удалён). */
  private async _destroyStream(writer: WindowWriter): Promise<void> {
    const stream = writer.stream;
    if (!stream) return;
    writer.stream = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_STREAM_TIMEOUT_MS);
      timer.unref?.();
      stream.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      stream.destroy();
    });
  }

  // ───────────────────────── Naming и время ─────────────────────────

  private _routingKey(
    exchangeId: string,
    symbol: string,
    marketType: string,
    stream: CexStreamKind,
  ): string {
    return `${exchangeId}\n${symbol}\n${marketType}\n${stream}`;
  }

  /** Начало окна, содержащего момент `ms`. */
  private _windowStartOf(ms: number): number {
    return Math.floor(ms / this._windowMs) * this._windowMs;
  }

  /** Ближайшая граница окна ПОСЛЕ момента `ms`. */
  private _nextBoundary(ms: number): number {
    return this._windowStartOf(ms) + this._windowMs;
  }

  /**
   * Полный путь партиции окна.
   *
   * @remarks
   * Организация сохранена из legacy: `{utcDate}/{exchange}/`, метки времени
   * окна — Eastern Time. Добавлен сегмент `stream`; символ санитизируется
   * по `[/:]` (unified swap-символы CCXT содержат двоеточие).
   */
  private _buildFilePath(
    exchangeId: string,
    symbol: string,
    marketType: string,
    stream: CexStreamKind,
    windowStart: number,
  ): string {
    const utcDate = new Date(windowStart).toISOString().slice(0, 10);
    const windowEnd = windowStart + this._windowMs;
    const dateLabel = this._formatDateET(windowStart);
    const startLabel = this._formatTimeET(windowStart);
    const endLabel = this._formatTimeET(windowEnd);
    const safeSymbol = symbol.replace(/[/:]/g, '-');
    const fileName =
      `${exchangeId}_${safeSymbol}_${marketType}_${stream}_` +
      `${dateLabel}_${startLabel}-${endLabel}_ET.jsonl`;
    return path.join(this._outputDir, utcDate, exchangeId, fileName);
  }

  /** Дата окна в Eastern Time: `2026-August-25`. */
  private _formatDateET(ms: number): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: 'long',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const year = parts.find((part) => part.type === 'year')!.value;
    const month = parts.find((part) => part.type === 'month')!.value;
    const day = parts.find((part) => part.type === 'day')!.value;
    return `${year}-${month}-${day}`;
  }

  /** Время в Eastern Time: `0955AM`. */
  private _formatTimeET(ms: number): string {
    const raw = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(ms));
    return raw.replace(':', '').replace(' ', '');
  }
}
