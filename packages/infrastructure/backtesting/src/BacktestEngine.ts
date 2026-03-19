/**
 * BacktestEngine — движок воспроизведения записанных рыночных снапшотов.
 *
 * @remarks
 * Главный оркестратор бектестирования: читает NDJSON-файлы, записанные
 * `@polymarket/data-collection`, и прогоняет их через те же application-layer
 * хендлеры, что используются при live-торговле.
 *
 * ### Поддерживаемые форматы файлов:
 *
 * **Формат collect-data (актуальный):**
 * ```json
 * { "t": "meta", "marketId": "0x...", "tokenIds": ["...", "..."] }
 * { "event_type": "book", "asset_id": "...", "bids": [...], "asks": [...], "timestamp": "..." }
 * { "event_type": "last_trade_price", "asset_id": "...", "price": "...", "size": "...", "side": "BUY", "timestamp": "..." }
 * ```
 *
 * **Формат legacy (устаревший):**
 * ```json
 * { "_type": "META", ... }
 * { "_type": "EVENT", "event": { "asset_id": "...", "bids": [...], "asks": [...], "timestamp": "..." } }
 * ```
 *
 * ### Поток данных:
 * ```
 * filePaths → JsonlSnapshotReader (построчно)
 *   → meta строка → читаем marketId + tokenIds[outcomeIndex]
 *   → book событие → BookUpdateHandler.handleSnapshot() → BOOK_UPDATED в EventBus
 *   → last_trade_price → EventBus.publish(TRADE_RECEIVED)
 *   → ReplayClock.update(timestamp) перед каждым событием
 * ```
 *
 * ### Источники файлов:
 * - `config.filePaths` — явный список файлов (рекомендуется для бектеста одного рынка)
 * - `config.snapshotDir` + `fromDate/toDate/marketId` — сканирование директории через SnapshotScanner
 *
 * ### Обработка ошибок:
 * - Невалидный JSON → лог warn, счётчик ошибок++, продолжаем.
 * - Невалидный asset_id → лог warn, пропускаем строку.
 * - Ошибка Price/Quantity → лог warn, пропускаем уровень.
 * - Ошибка в BookUpdateHandler → лог error, счётчик ошибок++, продолжаем.
 *
 * @example
 * ```typescript
 * // Явный список файлов (одиночный снапшот):
 * const engine = new BacktestEngine(
 *   { filePaths: ['./snapshots/Bitcoin_Up_or_Down.jsonl'], outcomeIndex: 1 },
 *   { bookUpdateHandler, eventBus, replayClock, logger },
 * );
 *
 * // Сканирование директории:
 * const engine = new BacktestEngine(
 *   { snapshotDir: './data/snapshots', fromDate: '2026-01-01', outcomeIndex: 0 },
 *   { bookUpdateHandler, eventBus, replayClock, logger },
 * );
 *
 * const result = await engine.run();
 * console.log(`book=${result.bookEvents}, trades=${result.tradeEvents}, errors=${result.errors}`);
 * ```
 */
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import { asInstrumentId, asMarketId } from '@polymarket/ids';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import { Price, Quantity, TimestampService } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';
import type { PriceLevel } from '@polymarket/order-book';
import type { BookUpdateHandler } from '@polymarket/handlers';
import type { IEventBus } from '@polymarket/event-bus';
import { ReplayClock } from '@polymarket/time';
import {
  JsonlSnapshotReader,
  SnapshotScanner,
} from '@polymarket/snapshot-readers';

// ── Raw форматы снапшота ──────────────────────────────────────────────────────

/**
 * Meta-строка формата collect-data.
 * @internal
 */
interface RawMeta {
  readonly t: 'meta';
  readonly marketId: string;
  readonly tokenIds: string[];
}

/**
 * Уровень стакана (price + size строками).
 * @internal
 */
interface RawLevel {
  readonly price: string;
  readonly size: string;
}

/**
 * Событие стакана формата collect-data.
 * @internal
 */
interface RawBookEvent {
  readonly event_type: 'book';
  readonly asset_id: string;
  readonly timestamp: string;
  readonly bids: readonly RawLevel[];
  readonly asks: readonly RawLevel[];
}

/**
 * Событие сделки формата collect-data.
 * @internal
 */
interface RawTradeEvent {
  readonly event_type: 'last_trade_price';
  readonly asset_id: string;
  readonly timestamp: string;
  readonly price: string;
  readonly size: string;
  readonly side: string;
}

/**
 * Событие legacy-формата (устаревший).
 * @internal
 */
interface RawLegacyOrderbookEvent {
  readonly asset_id: string;
  readonly bids: readonly RawLevel[];
  readonly asks: readonly RawLevel[];
  readonly timestamp: string;
}

/**
 * Запись legacy-формата в NDJSON.
 * @internal
 */
interface LegacySnapshotRecord {
  readonly _type: string;
  readonly event?: RawLegacyOrderbookEvent;
}

// ── Конфигурация и зависимости ────────────────────────────────────────────────

/**
 * Конфигурация бектеста.
 *
 * @remarks
 * Укажите либо `filePaths` (явный список), либо `snapshotDir` (сканирование директории).
 */
export interface BacktestConfig {
  /**
   * Явный список путей к JSONL файлам снапшотов.
   * Используется в приоритете над `snapshotDir`.
   */
  readonly filePaths?: string[];
  /** Путь к корневой директории снапшотов (структура: `dir/YYYY-MM-DD/*.jsonl(.gz)`) */
  readonly snapshotDir?: string;
  /** Начальная дата включительно (YYYY-MM-DD). Если не указана — все даты. */
  readonly fromDate?: string;
  /** Конечная дата включительно (YYYY-MM-DD). Если не указана — все даты. */
  readonly toDate?: string;
  /** Фильтр по ID рынка (substring match в имени файла). Если не указан — все рынки. */
  readonly marketId?: string;
  /**
   * Индекс outcome токена из meta.tokenIds (0 = YES, 1 = NO).
   * Только этот токен обрабатывается.
   * @defaultValue 0
   */
  readonly outcomeIndex?: 0 | 1;
}

/**
 * Зависимости бектест-движка.
 */
export interface BacktestDeps {
  /** Application-layer хендлер обновлений стакана */
  readonly bookUpdateHandler: BookUpdateHandler;
  /**
   * EventBus для публикации TRADE_RECEIVED.
   * Обязателен только если снапшоты содержат `event_type: 'last_trade_price'`.
   */
  readonly eventBus?: IEventBus;
  /** Логгер */
  readonly logger: ILogger;
  /**
   * ReplayClock для синхронизации исторического времени.
   *
   * @remarks
   * `replayClock.update()` вызывается перед каждым событием — все компоненты
   * видят историческое время. При нарушении монотонности — логируем warn, пропускаем.
   */
  readonly replayClock?: ReplayClock;
}

/**
 * Результат выполнения бектеста.
 */
export interface BacktestResult {
  /** Количество обработанных файлов */
  readonly processedFiles: number;
  /** Количество обработанных событий стакана */
  readonly bookEvents: number;
  /** Количество обработанных событий ленты (сделок) */
  readonly tradeEvents: number;
  /**
   * Общее количество обработанных событий (bookEvents + tradeEvents).
   * @deprecated Используй bookEvents + tradeEvents для детализации.
   */
  readonly processedEvents: number;
  /** Общая длительность выполнения в миллисекундах */
  readonly durationMs: number;
  /** Количество ошибок (невалидный JSON, невалидные данные, и т.д.) */
  readonly errors: number;
  /** marketId из последнего обработанного файла */
  readonly marketId: MarketId | undefined;
  /** instrumentId обрабатываемого токена */
  readonly instrumentId: InstrumentId | undefined;
}

// ── Реализация ────────────────────────────────────────────────────────────────

/**
 * Движок бектестирования: воспроизводит снапшоты через application-layer хендлеры.
 *
 * @remarks
 * Использует те же хендлеры, что и live-торговля, обеспечивая
 * консистентность результатов бектеста с реальным поведением системы.
 */
export class BacktestEngine {
  private readonly _logger: ILogger;

  /**
   * Создаёт BacktestEngine.
   *
   * @param _config - Конфигурация бектеста
   * @param _deps - Зависимости (BookUpdateHandler, EventBus, ILogger)
   */
  constructor(
    private readonly _config: BacktestConfig,
    private readonly _deps: BacktestDeps,
  ) {
    this._logger = _deps.logger.child({ component: 'BacktestEngine' });
  }

  /**
   * Запускает воспроизведение снапшотов.
   *
   * @remarks
   * Алгоритм:
   * 1. Определяем список файлов: из `filePaths` или через SnapshotScanner.
   * 2. Для каждого файла читаем построчно через `JsonlSnapshotReader`.
   * 3. Meta-строку (`t === 'meta'`) → извлекаем marketId и tokenIds[outcomeIndex].
   * 4. `event_type === 'book'` → BookUpdateHandler.handleSnapshot() → BOOK_UPDATED.
   * 5. `event_type === 'last_trade_price'` → EventBus.publish(TRADE_RECEIVED).
   * 6. Перед каждым событием → ReplayClock.update(timestamp).
   *
   * @returns BacktestResult со статистикой
   *
   * @example
   * ```typescript
   * const result = await engine.run();
   * console.log(`book=${result.bookEvents}, trades=${result.tradeEvents}`);
   * ```
   */
  public async run(): Promise<BacktestResult> {
    const startTime = Date.now();
    const outcomeIndex = this._config.outcomeIndex ?? 0;

    this._logger.info('BacktestEngine starting', {
      filePaths: this._config.filePaths,
      snapshotDir: this._config.snapshotDir,
      outcomeIndex,
    });

    const filePaths = await this._resolveFilePaths();

    let processedFiles = 0;
    let bookEvents = 0;
    let tradeEvents = 0;
    let errors = 0;
    let marketId: MarketId | undefined;
    let instrumentId: InstrumentId | undefined;

    for (const filePath of filePaths) {
      this._logger.debug('Processing snapshot file', { filePath });
      const reader = new JsonlSnapshotReader(filePath);

      let fileMarketId: MarketId | undefined;
      let fileInstrumentId: InstrumentId | undefined;

      try {
        for await (const line of reader.readLines()) {
          let raw: Record<string, unknown>;
          try {
            raw = JSON.parse(line) as Record<string, unknown>;
          } catch {
            errors += 1;
            continue;
          }

          // ── Meta (формат collect-data) ──────────────────────────────────
          if (raw['t'] === 'meta') {
            const meta = raw as unknown as RawMeta;
            fileMarketId = asMarketId(meta.marketId) ?? undefined;
            const tokenId = meta.tokenIds[outcomeIndex];
            fileInstrumentId = tokenId ? (asInstrumentId(tokenId) ?? undefined) : undefined;
            this._logger.info('Meta loaded', {
              marketId: meta.marketId,
              tokenId,
              outcomeIndex,
            });
            continue;
          }

          // ── Определяем тип события ──────────────────────────────────────
          const eventType = raw['event_type'] as string | undefined;

          if (eventType === 'book' || eventType === 'last_trade_price') {
            // Формат collect-data
            if (!fileInstrumentId || !fileMarketId) continue;

            const assetId = raw['asset_id'] as string | undefined;
            if (assetId !== String(fileInstrumentId)) continue;

            if (eventType === 'book') {
              const result = await this._processBookEvent(
                raw as unknown as RawBookEvent,
                fileInstrumentId,
                filePath,
              );
              if (result) bookEvents += 1;
              else errors += 1;
            } else {
              const result = await this._processTradeEvent(
                raw as unknown as RawTradeEvent,
                fileInstrumentId,
                filePath,
              );
              if (result) tradeEvents += 1;
              else errors += 1;
            }
          } else if (raw['_type'] === 'EVENT' && raw['event']) {
            // Legacy формат
            const record = raw as unknown as LegacySnapshotRecord;
            if (!record.event) continue;

            const tokenId = asInstrumentId(record.event.asset_id);
            if (!tokenId) { errors += 1; continue; }

            const result = await this._processLegacyEvent(record.event, tokenId, filePath);
            if (result) bookEvents += 1;
            else errors += 1;
          }
        }

        marketId = fileMarketId ?? marketId;
        instrumentId = fileInstrumentId ?? instrumentId;
        processedFiles += 1;
      } catch (err) {
        this._logger.error('Failed to read snapshot file', {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        });
        errors += 1;
      } finally {
        await reader.close();
      }
    }

    const durationMs = Date.now() - startTime;
    const processedEvents = bookEvents + tradeEvents;

    this._logger.info('BacktestEngine finished', {
      processedFiles,
      bookEvents,
      tradeEvents,
      errors,
      durationMs,
    });

    return {
      processedFiles,
      bookEvents,
      tradeEvents,
      processedEvents,
      durationMs,
      errors,
      marketId,
      instrumentId,
    };
  }

  // ── Приватные методы ──────────────────────────────────────────────────────

  /**
   * Определяет список файлов для воспроизведения.
   *
   * @returns Массив путей к файлам
   */
  private async _resolveFilePaths(): Promise<string[]> {
    if (this._config.filePaths && this._config.filePaths.length > 0) {
      return this._config.filePaths;
    }

    if (!this._config.snapshotDir) {
      this._logger.warn('No filePaths and no snapshotDir specified, nothing to replay');
      return [];
    }

    const scanner = new SnapshotScanner(this._config.snapshotDir, this._logger);
    const scanResult = await scanner.scan({
      fromDate: this._config.fromDate,
      toDate: this._config.toDate,
      marketId: this._config.marketId,
    });

    this._logger.info('Snapshot scan complete', {
      totalFiles: scanResult.totalFiles,
      totalSizeBytes: scanResult.totalSizeBytes,
    });

    return scanResult.files.map((f) => f.filePath);
  }

  /**
   * Обрабатывает book-событие формата collect-data.
   *
   * @param event - Raw book событие
   * @param instrumentId - ID токена
   * @param filePath - Путь файла для логирования
   * @returns true если успешно
   */
  private async _processBookEvent(
    event: RawBookEvent,
    instrumentId: InstrumentId,
    filePath: string,
  ): Promise<boolean> {
    const tsResult = TimestampService.create(Number(event.timestamp));
    if (!tsResult.ok) return false;

    this._advanceClock(new Date(Number(event.timestamp)));

    const bids = this._convertLevels(event.bids, filePath);
    const asks = this._convertLevels(event.asks, filePath);

    try {
      await this._deps.bookUpdateHandler.handleSnapshot(instrumentId, bids, asks, tsResult.value);
      return true;
    } catch (err) {
      this._logger.error('BookUpdateHandler error', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Обрабатывает last_trade_price-событие формата collect-data.
   *
   * @param event - Raw trade событие
   * @param instrumentId - ID токена
   * @param filePath - Путь файла для логирования
   * @returns true если успешно
   */
  private async _processTradeEvent(
    event: RawTradeEvent,
    instrumentId: InstrumentId,
    filePath: string,
  ): Promise<boolean> {
    const tsResult = TimestampService.create(Number(event.timestamp));
    if (!tsResult.ok) return false;

    let price: Price;
    let size: Quantity;
    try {
      price = Price.of(new Decimal(event.price));
      size = Quantity.of(new Decimal(event.size));
    } catch {
      this._logger.warn('Invalid price/size in trade event', { filePath, price: event.price, size: event.size });
      return false;
    }

    const side = this._parseSide(event.side);
    if (!side) {
      this._logger.warn('Invalid side in trade event', { filePath, side: event.side });
      return false;
    }

    if (!this._deps.eventBus) {
      this._logger.warn('TRADE_RECEIVED skipped: eventBus not provided in deps');
      return false;
    }

    this._advanceClock(new Date(Number(event.timestamp)));

    // price и size точно инициализированы — try/catch выше вернул бы false при ошибке
    await this._deps.eventBus.publish({
      type: 'TRADE_RECEIVED',
      instrumentId,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      price: price!,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      size: size!,
      side,
      timestamp: tsResult.value,
    });

    return true;
  }

  /**
   * Обрабатывает событие legacy-формата (только book).
   *
   * @param event - Raw legacy событие
   * @param tokenId - ID токена
   * @param filePath - Путь файла
   * @returns true если успешно
   */
  private async _processLegacyEvent(
    event: RawLegacyOrderbookEvent,
    tokenId: InstrumentId,
    filePath: string,
  ): Promise<boolean> {
    const tsResult = TimestampService.create(Number(event.timestamp));
    if (!tsResult.ok) return false;

    this._advanceClock(new Date(Number(event.timestamp)));

    const bids = this._convertLevels(event.bids, filePath);
    const asks = this._convertLevels(event.asks, filePath);

    try {
      await this._deps.bookUpdateHandler.handleSnapshot(tokenId, bids, asks, tsResult.value);
      return true;
    } catch (err) {
      this._logger.error('BookUpdateHandler error (legacy)', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Продвигает ReplayClock к timestamp события (с защитой от out-of-order).
   *
   * @param date - Timestamp события
   */
  private _advanceClock(date: Date): void {
    if (!this._deps.replayClock) return;
    try {
      this._deps.replayClock.update(date);
    } catch {
      // out-of-order timestamp — оставляем clock на текущем значении
      this._logger.warn('ReplayClock: out-of-order event, skipping clock update');
    }
  }

  /**
   * Конвертирует raw уровни стакана в PriceLevel[] (Value Objects).
   *
   * @param levels - Массив { price, size } из JSON
   * @param filePath - Путь файла для логирования
   * @returns PriceLevel[] с Value Objects
   */
  private _convertLevels(
    levels: readonly RawLevel[],
    filePath: string,
  ): PriceLevel[] {
    const result: PriceLevel[] = [];
    for (const level of levels) {
      try {
        result.push({
          price: Price.of(new Decimal(level.price)),
          size: Quantity.of(new Decimal(level.size)),
        });
      } catch {
        this._logger.warn('Invalid price level, skipping', {
          price: level.price,
          size: level.size,
          file: filePath,
        });
      }
    }
    return result;
  }

  /**
   * Парсит сторону сделки из строки.
   *
   * @param raw - Строка 'BUY' или 'SELL'
   * @returns Side или undefined если невалидно
   */
  private _parseSide(raw: string): Side | undefined {
    if (raw === 'BUY' || raw === 'SELL') return raw;
    return undefined;
  }
}
