/**
 * DataRecorder — запись сырых WS-событий в NDJSON-файлы.
 *
 * @remarks
 * ### Назначение:
 * Реализует `IMarketDataRecorder` из `@polymarket/ports`.
 * Записывает сырые события с биржи на диск для воспроизведения в бектесте.
 *
 * ### Структура файлов:
 * ```
 * outputDir/
 *   2026-01-01/
 *     Bitcoin_Up___0xabc.jsonl(.gz)
 *     Ethereum_Down___0xdef.jsonl(.gz)
 *   2026-01-02/
 *     ...
 * ```
 *
 * ### Первая запись в файл — meta-событие:
 * ```json
 * {"t":"meta","ts":1234567890,"marketId":"0x...","question":"...","tokenIds":["0x..."]}
 * ```
 *
 * ### Буферизация:
 * - События накапливаются в памяти (строки NDJSON)
 * - Сброс при `buffer.length >= bufferSize` (100 событий)
 * - Сброс по таймеру каждые `flushIntervalMs` (10 сек)
 * - Обратный индекс `tokenId → MarketWriter` для O(1) маршрутизации
 *
 * @example
 * ```typescript
 * const recorder = new DataRecorder(config, new NDJSONFormatter(), new GzipCompressor(), logger);
 * recorder.registerMarket({ marketId, question, tokenIds, expiresAt });
 * recorder.recordEvent('0xyes...', { event_type: 'book', ... });
 * await recorder.finalizeMarket(marketId, 'EXPIRED');
 * await recorder.close();
 * ```
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ILogger } from '@polymarket/logger';
import type { MarketId } from '@polymarket/ids';
import type { IMarketDataRecorder, MarketMeta } from '@polymarket/ports';
import type { DataRecorderConfig } from './config/DataRecorderConfig.js';
import type { IFormatter } from './formatters/IFormatter.js';
import type { GzipCompressor } from './compression/GzipCompressor.js';

/**
 * Буферизированное событие с timestamp для сортировки перед записью.
 *
 * @remarks
 * Хранит извлечённый timestamp и отформатированную NDJSON-строку.
 * При flush буфер сортируется по `ts`, чтобы crypto_price события
 * были перемешаны с book/trade в хронологическом порядке.
 */
interface BufferedEvent {
  /** Timestamp события в Unix ms (для сортировки) */
  readonly ts: number;
  /** Отформатированная NDJSON-строка (с trailing newline) */
  readonly line: string;
}

/**
 * Внутреннее состояние записи для одного рынка.
 */
interface MarketWriter {
  readonly meta: MarketMeta;
  readonly filePath: string;
  buffer: BufferedEvent[];
  stream: fs.WriteStream | null;
  lastFlushTime: number;
  eventsRecorded: number;
}

/**
 * Реализация IMarketDataRecorder.
 *
 * @remarks
 * Thread-safe только в single-threaded Node.js окружении.
 */
export class DataRecorder implements IMarketDataRecorder {
  private readonly _logger: ILogger;
  /** Хранилище состояния: marketId → MarketWriter */
  private readonly _writers = new Map<string, MarketWriter>();
  /** Обратный индекс для O(1) маршрутизации: tokenId → MarketWriter */
  private readonly _tokenIndex = new Map<string, MarketWriter>();
  /** Таймер периодического сброса буферов */
  private _flushTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param _config - Конфигурация рекордера
   * @param _formatter - Форматировщик записей
   * @param _compressor - Компрессор (null = сжатие отключено)
   * @param logger - Логгер
   */
  constructor(
    private readonly _config: DataRecorderConfig,
    private readonly _formatter: IFormatter,
    private readonly _compressor: GzipCompressor | null,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'DataRecorder' });
    this._startFlushTimer();
  }

  /**
   * Проверяет, включён ли рекордер.
   *
   * @returns Всегда true — экземпляр DataRecorder создаётся только когда запись включена
   */
  public isEnabled(): boolean {
    return true;
  }

  /**
   * Регистрирует рынок: создаёт файл, записывает meta-событие.
   *
   * @param meta - Метаданные рынка
   *
   * @remarks
   * Идемпотентный — повторный вызов для того же marketId — no-op.
   */
  public registerMarket(meta: MarketMeta): void {
    const key = String(meta.marketId);
    if (this._writers.has(key)) {
      this._logger.debug('Market already registered, skipping', { marketId: key });
      return;
    }

    const filePath = this._buildFilePath(meta);

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      // Если файл уже существует от предыдущего запуска — удаляем.
      // Это предотвращает дублирование meta-записей при повторном старте без graceful shutdown.
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this._logger.warn('Existing market file deleted (previous run, no graceful shutdown)', {
          marketId: key,
          filePath,
        });
      }

      // Синхронно записываем meta-событие: файл гарантированно появляется на диске
      // до создания WriteStream. Это позволяет тестам и мониторингу сразу видеть файл.
      const metaRecord: Record<string, unknown> = {
        t: 'meta',
        ts: Date.now(),
        marketId: key,
        question: meta.question,
        tokenIds: Array.from(meta.tokenIds),
      };
      if (meta.rawMarket) {
        metaRecord['m'] = meta.rawMarket;
      }
      const metaLine = this._formatter.formatRecord(metaRecord);
      fs.writeFileSync(filePath, metaLine, { flag: 'a' });

      // Открываем поток в режиме append после того, как файл создан синхронно
      const stream = fs.createWriteStream(filePath, { flags: 'a' });

      stream.on('error', (err) => {
        this._logger.error('Write stream error', { marketId: key, filePath, err });
      });

      const writer: MarketWriter = {
        meta,
        filePath,
        buffer: [],
        stream,
        lastFlushTime: Date.now(),
        eventsRecorded: 0,
      };

      this._writers.set(key, writer);
      for (const tokenId of meta.tokenIds) {
        this._tokenIndex.set(tokenId, writer);
      }

      this._logger.debug('Market registered for recording', {
        marketId: key,
        question: meta.question,
        tokenCount: meta.tokenIds.length,
        filePath,
      });
    } catch (err) {
      this._logger.error('Failed to register market', {
        marketId: key,
        filePath,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Записывает сырое WS-событие в буфер (синхронно, fire-and-forget).
   *
   * @param tokenId - ID токена (YES или NO)
   * @param rawEvent - Сырое событие
   *
   * @remarks
   * Никогда не бросает. O(1) поиск через tokenIndex.
   * Извлекает timestamp из события для сортировки при flush.
   * Поддерживаемые поля: `timestamp` (string|number), `ts` (number).
   */
  public recordEvent(tokenId: string, rawEvent: unknown): void {
    const writer = this._tokenIndex.get(tokenId);
    if (!writer) return;

    try {
      const line = this._formatter.formatRecord(rawEvent as object);
      const ts = this._extractTimestamp(rawEvent);
      writer.buffer.push({ ts, line });
      writer.eventsRecorded++;

      if (writer.buffer.length >= this._config.bufferSize) {
        void this._flushWriter(writer);
      }
    } catch {
      // Ошибка форматирования — пропускаем событие, не блокируем trading path
    }
  }

  /**
   * Завершает запись рынка: сбрасывает буфер, закрывает поток, сжимает файл.
   *
   * @param marketId - ID рынка
   * @param reason - Причина завершения
   *
   * @throws При ошибке I/O
   */
  public async finalizeMarket(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    const key = String(marketId);
    const writer = this._writers.get(key);
    if (!writer) {
      this._logger.debug('finalizeMarket: market not found', { marketId: key });
      return;
    }

    // Удаляем из индексов до завершения (новые события игнорируются)
    this._writers.delete(key);
    for (const tokenId of writer.meta.tokenIds) {
      this._tokenIndex.delete(tokenId);
    }

    await this._flushWriter(writer);

    await new Promise<void>((resolve, reject) => {
      if (!writer.stream) {
        resolve();
        return;
      }
      writer.stream.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (reason === 'EXPIRED') {
      // Рынок истёк — данные валидны, сжимаем если включено
      if (this._config.compression === 'gzip' && this._compressor) {
        try {
          const gzPath = await this._compressor.compressFile(writer.filePath);
          this._logger.debug('Market file compressed', { marketId: key, gzPath });
        } catch (err) {
          this._logger.warn('Failed to compress market file', {
            marketId: key,
            filePath: writer.filePath,
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }

      this._logger.info('Market finalized (expired)', {
        marketId: key,
        eventsRecorded: writer.eventsRecorded,
        filePath: writer.filePath,
      });
    } else {
      // Рынок не истёк (shutdown) — удаляем незаконченный файл.
      // Неполные данные бесполезны для бэктеста и занимают место.
      try {
        await fs.promises.unlink(writer.filePath);
        this._logger.info('Incomplete market file deleted on shutdown', {
          marketId: key,
          eventsRecorded: writer.eventsRecorded,
          filePath: writer.filePath,
        });
      } catch (err) {
        this._logger.warn('Failed to delete incomplete market file', {
          marketId: key,
          filePath: writer.filePath,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }

  /**
   * Очищает артефакты от предыдущих запусков.
   *
   * @remarks
   * Незаконченные файлы рынков теперь удаляются сразу при graceful shutdown.
   * Файлы оставшиеся от краш-сценариев (SIGKILL) удаляются в `registerMarket()`
   * при следующем старте через delete-if-exists логику.
   *
   * Метод оставлен для совместимости и на случай оставшихся .incomplete/ папок
   * от старых версий коллектора.
   */
  public async cleanup(): Promise<void> {
    const incompleteDir = path.join(this._config.outputDir, '.incomplete');
    if (!fs.existsSync(incompleteDir)) return;

    const files = await fs.promises.readdir(incompleteDir);
    for (const file of files) {
      try {
        await fs.promises.unlink(path.join(incompleteDir, file));
      } catch {
        // ignore
      }
    }
    try {
      await fs.promises.rmdir(incompleteDir);
    } catch {
      // ignore
    }
    if (files.length > 0) {
      this._logger.info('Cleaned up legacy .incomplete market files', { count: files.length });
    }
  }

  /**
   * Принудительно сбрасывает все буферы на диск.
   *
   * @throws При ошибке записи
   */
  public async flush(): Promise<void> {
    await this._flushAll();
  }

  /**
   * Завершает работу: финализирует все рынки, останавливает таймеры.
   *
   * @throws При ошибке I/O
   */
  public async close(): Promise<void> {
    this._stopFlushTimer();

    const marketIds = [...this._writers.keys()];
    this._logger.info('Closing DataRecorder', { activeMarkets: marketIds.length });

    await Promise.all(
      marketIds.map((id) =>
        this.finalizeMarket(id as unknown as MarketId, 'SHUTDOWN'),
      ),
    );

    // Удаляем пустые date-директории после удаления незаконченных файлов
    await this._removeEmptyDateDirs();

    this._logger.info('DataRecorder closed');
  }

  /**
   * Удаляет пустые date-директории в outputDir.
   *
   * @remarks
   * После удаления незаконченных файлов при shutdown date-директории
   * (e.g. `2026-03-21/`) могут остаться пустыми. Этот метод их подчищает.
   */
  private async _removeEmptyDateDirs(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(this._config.outputDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(this._config.outputDir, entry.name);
        const files = await fs.promises.readdir(dirPath);
        if (files.length === 0) {
          await fs.promises.rmdir(dirPath);
          this._logger.debug('Removed empty date directory', { dir: dirPath });
        }
      }
    } catch {
      // outputDir может не существовать — игнорируем
    }
  }

  // ── Приватные методы ──────────────────────────────────────────────────────

  /**
   * Строит путь к файлу для рынка.
   * Формат: `outputDir/YYYY-MM-DD/{sanitizedQuestion}___{marketId}.{ext}`
   *
   * @param meta - Метаданные рынка
   * @returns Абсолютный путь к файлу
   */
  private _buildFilePath(meta: MarketMeta): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const safeQuestion = meta.question
      .replace(/[^\w\s-]/g, '')   // оставляем буквы, цифры, дефис, пробелы
      .replace(/\s+/g, '_')       // пробелы → _
      .slice(0, 80);              // ограничение длины
    const marketId = String(meta.marketId).slice(0, 40);
    const fileName = `${safeQuestion}___${marketId}.${this._formatter.extension}`;
    return path.join(this._config.outputDir, date, fileName);
  }

  /**
   * Сбрасывает буфер одного рынка на диск.
   *
   * @param writer - Внутреннее состояние рынка
   *
   * @remarks
   * Сортирует события по timestamp перед записью, чтобы crypto_price
   * и book/trade были перемешаны в хронологическом порядке.
   * При реплее в бектесте события приходят так же, как в реальном времени.
   *
   * @throws При ошибке записи в поток
   */
  private async _flushWriter(writer: MarketWriter): Promise<void> {
    if (writer.buffer.length === 0 || !writer.stream) return;

    // Сортируем по timestamp для хронологического порядка в файле
    writer.buffer.sort((a, b) => a.ts - b.ts);

    const data = writer.buffer.map((e) => e.line).join('');
    writer.buffer = [];
    writer.lastFlushTime = Date.now();

    await new Promise<void>((resolve, reject) => {
      writer.stream!.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Сбрасывает буферы всех активных рынков.
   *
   * @throws При ошибке записи
   */
  private async _flushAll(): Promise<void> {
    await Promise.all(
      [...this._writers.values()].map((w) => this._flushWriter(w)),
    );
  }

  /**
   * Извлекает timestamp из сырого события для сортировки в буфере.
   *
   * @param rawEvent - Сырое событие (book, trade, crypto_price и т.д.)
   * @returns Timestamp в Unix ms. Если не найден — Date.now() (fallback).
   *
   * @remarks
   * Поддерживаемые поля:
   * - `timestamp` (string|number) — book/trade события Polymarket WS
   * - `ts` (number) — crypto_price и meta события
   */
  private _extractTimestamp(rawEvent: unknown): number {
    if (rawEvent && typeof rawEvent === 'object') {
      const obj = rawEvent as Record<string, unknown>;
      // WS book/trade: timestamp (строка Unix ms)
      if (obj['timestamp'] !== undefined) {
        const v = Number(obj['timestamp']);
        if (!Number.isNaN(v)) return v;
      }
      // crypto_price / meta: ts (число)
      if (obj['ts'] !== undefined) {
        const v = Number(obj['ts']);
        if (!Number.isNaN(v)) return v;
      }
    }
    return Date.now();
  }

  /**
   * Запускает таймер периодического сброса.
   */
  private _startFlushTimer(): void {
    this._flushTimer = setInterval(() => {
      void this._flushAll();
    }, this._config.flushIntervalMs);

    // Не блокируем завершение процесса
    if (this._flushTimer.unref) {
      this._flushTimer.unref();
    }
  }

  /**
   * Останавливает таймер периодического сброса.
   */
  private _stopFlushTimer(): void {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }
}
