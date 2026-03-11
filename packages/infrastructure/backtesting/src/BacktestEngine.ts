/**
 * BacktestEngine — движок воспроизведения записанных рыночных снапшотов.
 *
 * @remarks
 * Главный оркестратор бектестирования: читает NDJSON-файлы, записанные
 * `@polymarket/data-collection`, и прогоняет их через те же application-layer
 * хендлеры, что используются при live-торговле.
 *
 * ### Поток данных при бектесте:
 * ```
 * SnapshotScanner → список файлов (фильтр по дате/рынку)
 *   → SnapshotReaderFactory → ISnapshotReader (JSONL / JSONL.GZ)
 *     → построчное чтение
 *       → JSON.parse(line)
 *         → если _type === 'EVENT' → извлекаем event
 *           → replayClock?.update(event.timestamp)  ← синхронизация времени
 *           → конвертируем уровни стакана в PriceLevel[]
 *             → BookUpdateHandler.handleSnapshot(tokenId, bids, asks, timestamp)
 * ```
 *
 * ### Формат записей в NDJSON-файле:
 * ```json
 * { "_type": "META", ... }
 * { "_type": "EVENT", "event": { "asset_id": "...", "bids": [...], "asks": [...], "timestamp": "..." } }
 * ```
 *
 * ### Обработка ошибок:
 * - Невалидный JSON → лог warn, счётчик ошибок++, продолжаем.
 * - Невалидный asset_id → лог warn, пропускаем строку.
 * - Ошибка Price/Quantity → лог warn, пропускаем уровень (как в MarketDataFeedAdapter).
 * - Ошибка в BookUpdateHandler → лог error, счётчик ошибок++, продолжаем.
 *
 * @example
 * ```typescript
 * const engine = new BacktestEngine(
 *   { snapshotDir: './data/snapshots', fromDate: '2026-01-01' },
 *   { bookUpdateHandler: handler, logger },
 * );
 *
 * const result = await engine.run();
 * console.log(`Processed ${result.processedEvents} events in ${result.durationMs}ms`);
 * ```
 */
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import { asInstrumentId } from '@polymarket/ids';
import { Price, Quantity, TimestampService } from '@polymarket/value-objects';
import type { PriceLevel } from '@polymarket/order-book';
import type { BookUpdateHandler } from '@polymarket/handlers';
import { ReplayClock } from '@polymarket/time';
import {
  SnapshotScanner,
  SnapshotReaderFactory,
} from '@polymarket/snapshot-readers';

/**
 * Конфигурация бектеста.
 */
export interface BacktestConfig {
  /** Путь к корневой директории снапшотов (структура: `dir/YYYY-MM-DD/*.jsonl(.gz)`) */
  readonly snapshotDir: string;
  /** Начальная дата включительно (YYYY-MM-DD). Если не указана — все даты. */
  readonly fromDate?: string;
  /** Конечная дата включительно (YYYY-MM-DD). Если не указана — все даты. */
  readonly toDate?: string;
  /** Фильтр по ID рынка (substring match в имени файла). Если не указан — все рынки. */
  readonly marketId?: string;
}

/**
 * Зависимости бектест-движка.
 */
export interface BacktestDeps {
  /** Application-layer хендлер обновлений стакана */
  readonly bookUpdateHandler: BookUpdateHandler;
  /** Логгер */
  readonly logger: ILogger;
  /**
   * Опциональный ReplayClock для синхронизации исторического времени.
   *
   * @remarks
   * Если передан — `replayClock.update()` вызывается перед обработкой каждого события,
   * синхронизируя `clock.now()` с временем из снапшота.
   * Это обеспечивает детерминизм: все компоненты, зависящие от `IClock`,
   * видят историческое время вместо реального.
   *
   * При нарушении монотонности (событие с более ранним timestamp) — логируем warn,
   * пропускаем обновление clock и продолжаем обработку.
   */
  readonly replayClock?: ReplayClock;
}

/**
 * Результат выполнения бектеста.
 */
export interface BacktestResult {
  /** Количество обработанных файлов */
  readonly processedFiles: number;
  /** Количество обработанных событий (записей типа EVENT) */
  readonly processedEvents: number;
  /** Общая длительность выполнения в миллисекундах */
  readonly durationMs: number;
  /** Количество ошибок (невалидный JSON, ошибки хендлера, и т.д.) */
  readonly errors: number;
}

/**
 * DTO для одного уровня стакана из WS-снапшота (raw формат).
 *
 * @internal
 */
interface RawLevel {
  readonly price: string;
  readonly size: string;
}

/**
 * DTO события стакана из записанного снапшота (raw формат Polymarket WS).
 *
 * @internal
 */
interface RawOrderbookEvent {
  readonly asset_id: string;
  readonly bids: readonly RawLevel[];
  readonly asks: readonly RawLevel[];
  readonly timestamp: string;
}

/**
 * Запись в NDJSON файле снапшота.
 *
 * @internal
 */
interface SnapshotRecord {
  readonly _type: string;
  readonly event?: RawOrderbookEvent;
}

/**
 * Движок бектестирования: воспроизводит снапшоты через application-layer хендлеры.
 *
 * @remarks
 * Использует те же хендлеры, что и live-торговля, обеспечивая
 * консистентность результатов бектеста с реальным поведением системы.
 */
export class BacktestEngine {
  private readonly _logger: ILogger;
  private readonly _scanner: SnapshotScanner;
  private readonly _readerFactory: SnapshotReaderFactory;

  /**
   * Создаёт BacktestEngine.
   *
   * @param _config - Конфигурация бектеста (директория, фильтры дат/рынка)
   * @param _deps - Зависимости (BookUpdateHandler, ILogger)
   *
   * @example
   * ```typescript
   * const engine = new BacktestEngine(
   *   { snapshotDir: './data/snapshots' },
   *   { bookUpdateHandler, logger },
   * );
   * ```
   */
  constructor(
    private readonly _config: BacktestConfig,
    private readonly _deps: BacktestDeps,
  ) {
    this._logger = _deps.logger.child({ component: 'BacktestEngine' });
    this._scanner = new SnapshotScanner(_config.snapshotDir, this._logger);
    this._readerFactory = new SnapshotReaderFactory(this._logger);
  }

  /**
   * Запускает воспроизведение снапшотов.
   *
   * @remarks
   * Алгоритм:
   * 1. Вызываем `SnapshotScanner.scan()` с фильтрами из конфига.
   * 2. Для каждого найденного файла создаём `ISnapshotReader` через `SnapshotReaderFactory`.
   * 3. Читаем файл построчно через `reader.readLines()`.
   * 4. Парсим каждую строку как JSON.
   * 5. Если `_type === 'EVENT'` и `event` присутствует:
   *    а. Конвертируем `event.asset_id` в `InstrumentId`.
   *    б. Конвертируем `event.bids`/`event.asks` в `PriceLevel[]`.
   *    в. Вызываем `bookUpdateHandler.handleSnapshot(tokenId, bids, asks, timestamp)`.
   * 6. Считаем статистику (processedFiles, processedEvents, errors).
   * 7. После каждого файла вызываем `reader.close()`.
   * 8. Возвращаем `BacktestResult`.
   *
   * @returns BacktestResult со статистикой выполнения
   *
   * @example
   * ```typescript
   * const result = await engine.run();
   * console.log(`Files: ${result.processedFiles}`);
   * console.log(`Events: ${result.processedEvents}`);
   * console.log(`Errors: ${result.errors}`);
   * console.log(`Duration: ${result.durationMs}ms`);
   * ```
   */
  public async run(): Promise<BacktestResult> {
    const startTime = Date.now();

    this._logger.info('BacktestEngine starting', {
      snapshotDir: this._config.snapshotDir,
      fromDate: this._config.fromDate,
      toDate: this._config.toDate,
      marketId: this._config.marketId,
    });

    const scanResult = await this._scanner.scan({
      fromDate: this._config.fromDate,
      toDate: this._config.toDate,
      marketId: this._config.marketId,
    });

    this._logger.info('Snapshot scan complete', {
      totalFiles: scanResult.totalFiles,
      totalSizeBytes: scanResult.totalSizeBytes,
    });

    let processedFiles = 0;
    let processedEvents = 0;
    let errors = 0;

    for (const fileInfo of scanResult.files) {
      this._logger.debug('Processing snapshot file', {
        file: fileInfo.fileName,
        date: fileInfo.date,
        sizeBytes: fileInfo.sizeBytes,
      });

      const reader = this._readerFactory.create(fileInfo.filePath);

      try {
        for await (const line of reader.readLines()) {
          const parseResult = this._parseLine(line);
          if (!parseResult.ok) {
            this._logger.warn('Failed to parse snapshot line', {
              file: fileInfo.fileName,
              error: parseResult.error,
            });
            errors += 1;
            continue;
          }

          const record = parseResult.value;

          if (record._type !== 'EVENT' || !record.event) {
            continue;
          }

          const handlerResult = await this._processEvent(record.event, fileInfo.fileName);
          if (!handlerResult.ok) {
            errors += 1;
            continue;
          }

          processedEvents += 1;
        }

        processedFiles += 1;
      } catch (err) {
        this._logger.error('Failed to read snapshot file', {
          file: fileInfo.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
        errors += 1;
      } finally {
        await reader.close();
      }
    }

    const durationMs = Date.now() - startTime;

    this._logger.info('BacktestEngine finished', {
      processedFiles,
      processedEvents,
      errors,
      durationMs,
    });

    return {
      processedFiles,
      processedEvents,
      durationMs,
      errors,
    };
  }

  // ── Приватные методы ──────────────────────────────────────────────────────

  /**
   * Разбирает строку NDJSON в объект записи снапшота.
   *
   * @param line - Одна строка из NDJSON файла
   * @returns Ok(SnapshotRecord) при успехе, Err(сообщение ошибки) при невалидном JSON
   *
   * @remarks
   * Обрабатывает ошибки парсинга и типизирует результат.
   * Строки с невалидным JSON возвращают Err.
   */
  private _parseLine(
    line: string,
  ): { ok: true; value: SnapshotRecord } | { ok: false; error: string } {
    try {
      const parsed = JSON.parse(line) as SnapshotRecord;
      return { ok: true, value: parsed };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Обрабатывает одно EVENT-событие: конвертирует и передаёт в BookUpdateHandler.
   *
   * @remarks
   * Алгоритм:
   * 1. Конвертируем `event.asset_id` в `InstrumentId` через `asInstrumentId()`.
   * 2. Конвертируем `event.bids`/`event.asks` в `PriceLevel[]` через `_convertLevels()`.
   * 3. Вызываем `bookUpdateHandler.handleSnapshot()`.
   *
   * @param event - Raw DTO события из снапшота
   * @param fileName - Имя файла для логирования
   * @returns Ok(void) при успехе, Err(сообщение ошибки) при ошибке
   */
  private async _processEvent(
    event: RawOrderbookEvent,
    fileName: string,
  ): Promise<{ ok: true; value: void } | { ok: false; error: string }> {
    const tokenId = asInstrumentId(event.asset_id);
    if (!tokenId) {
      this._logger.warn('Invalid asset_id in snapshot event, skipping', {
        asset_id: event.asset_id,
        file: fileName,
      });
      return { ok: false, error: `Invalid asset_id: ${event.asset_id}` };
    }

    const bids = this._convertLevels(event.bids, fileName);
    const asks = this._convertLevels(event.asks, fileName);
    const tsResult = TimestampService.create(Number(event.timestamp));
    if (!tsResult.ok) {
      this._logger.warn('Invalid timestamp in snapshot event, skipping', {
        asset_id: event.asset_id,
        timestamp: event.timestamp,
        file: fileName,
      });
      return { ok: false, error: `Invalid timestamp: ${event.timestamp}` };
    }

    // Синхронизируем ReplayClock с историческим временем события (если передан)
    if (this._deps.replayClock) {
      try {
        this._deps.replayClock.update(tsResult.value.toDate());
      } catch {
        // Нарушение монотонности: событие с более ранним timestamp (out-of-order между файлами).
        // Логируем warn, оставляем clock на текущем значении и продолжаем.
        this._logger.warn('ReplayClock: out-of-order event timestamp, skipping clock update', {
          asset_id:  event.asset_id,
          timestamp: event.timestamp,
          file:      fileName,
        });
      }
    }

    try {
      await this._deps.bookUpdateHandler.handleSnapshot(tokenId, bids, asks, tsResult.value);
      return { ok: true, value: undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('BookUpdateHandler failed processing snapshot event', {
        asset_id: event.asset_id,
        file: fileName,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  /**
   * Конвертирует raw уровни стакана в PriceLevel[] (Value Objects).
   *
   * @remarks
   * Повторяет логику `MarketDataFeedAdapter._convertLevels()`:
   * - Создаёт `Price.of(new Decimal(level.price))` и `Quantity.of(new Decimal(level.size))`.
   * - Если уровень невалиден (исключение Price/Quantity) — пропускает с лог warn.
   * - Конвертация происходит на границе инфраструктуры до передачи в application layer.
   *
   * @param levels - Raw уровни стакана из WS-снапшота
   * @param fileName - Имя файла для логирования
   * @returns Массив PriceLevel с типизированными Value Objects
   */
  private _convertLevels(
    levels: readonly RawLevel[],
    fileName: string,
  ): PriceLevel[] {
    const result: PriceLevel[] = [];

    for (const level of levels) {
      try {
        const price = Price.of(new Decimal(level.price));
        const size = Quantity.of(new Decimal(level.size));
        result.push({ price, size });
      } catch {
        this._logger.warn('Invalid price level in snapshot, skipping', {
          price: level.price,
          size: level.size,
          file: fileName,
        });
      }
    }

    return result;
  }
}
