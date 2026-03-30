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
  SnapshotReaderFactory,
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
  /** Сырой rawMarket из Gamma API (обновлённый при finalize) */
  readonly m?: Record<string, unknown>;
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
  /**
   * Реплеить trade tape комплементарного токена (другой outcome).
   *
   * @remarks
   * Если true, события `last_trade_price` для tokenIds[1 - outcomeIndex]
   * тоже публикуются в EventBus. Это позволяет стратегии получать
   * `complementaryTradeTape` в snapshot для сравнения momentum обоих токенов.
   *
   * @defaultValue false
   */
  readonly replayComplementaryTrades?: boolean;
}

/**
 * Интерфейс CryptoPriceStore для BacktestEngine.
 *
 * @remarks
 * Минимальный интерфейс для передачи крипто-цен при реплее.
 */
export interface IBacktestCryptoPriceStore {
  get(symbolOrAsset: string): { targetPrice: number | undefined } | undefined;
  updatePrice(symbol: string, price: number, timestampMs: number): void;
  setTargetPrice(symbolOrAsset: string, price: number): void;
  setResolutionPrice(symbolOrAsset: string, price: number): void;
  /** Устанавливает и блокирует targetPrice (priceToBeat из meta) от перезаписи */
  lockTargetPrice(symbolOrAsset: string, price: number): void;
  /** Устанавливает и блокирует resolutionPrice (finalPrice из meta) от перезаписи */
  lockResolutionPrice(symbolOrAsset: string, price: number): void;
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
  /** Опциональный store крипто-цен для реплея crypto_price событий */
  readonly cryptoPriceStore?: IBacktestCryptoPriceStore;
  /**
   * Парсер крипто-метаданных из rawMarket.
   *
   * @remarks
   * Используется для извлечения priceToBeat и finalPrice из meta строки.
   * Если не предоставлен — fallback на strike_price/market_resolved события.
   */
  readonly parseCryptoMeta?: (rawMarket: Record<string, unknown>) => { rtdsFilter: string; priceToBeat?: number; finalPrice?: number } | undefined;
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
  /** Количество обработанных crypto_price событий */
  readonly cryptoPriceEvents: number;
  /** Количество ошибок (невалидный JSON, невалидные данные, и т.д.) */
  readonly errors: number;
  /** marketId из последнего обработанного файла */
  readonly marketId: MarketId | undefined;
  /** instrumentId обрабатываемого токена */
  readonly instrumentId: InstrumentId | undefined;
  /** instrumentId комплементарного токена (если replayComplementaryTrades=true) */
  readonly complementaryInstrumentId: InstrumentId | undefined;
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

    const replayComplementary = this._config.replayComplementaryTrades ?? false;

    let processedFiles = 0;
    let bookEvents = 0;
    let tradeEvents = 0;
    let cryptoPriceEvents = 0;
    let errors = 0;
    let marketId: MarketId | undefined;
    let instrumentId: InstrumentId | undefined;
    let complementaryInstrumentId: InstrumentId | undefined;

    for (const filePath of filePaths) {
      this._logger.debug('Processing snapshot file', { filePath });
      const readerFactory = new SnapshotReaderFactory(this._logger);
      const reader = readerFactory.create(filePath);

      let fileMarketId: MarketId | undefined;
      let fileInstrumentId: InstrumentId | undefined;
      let fileComplementaryId: InstrumentId | undefined;

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

            // Комплементарный токен (другой outcome) для dual-token стратегий
            if (replayComplementary) {
              const compIndex = 1 - outcomeIndex;
              const compTokenId = meta.tokenIds[compIndex];
              fileComplementaryId = compTokenId ? (asInstrumentId(compTokenId) ?? undefined) : undefined;
              if (fileComplementaryId) {
                this._logger.info('Complementary token registered', {
                  complementaryTokenId: compTokenId,
                  complementaryIndex: compIndex,
                });
              }
            }

            // Извлекаем priceToBeat и finalPrice из rawMarket (eventMetadata)
            if (this._deps.cryptoPriceStore && meta.m) {
              const cryptoMeta = this._deps.parseCryptoMeta?.(meta.m as Record<string, unknown>);
              if (cryptoMeta) {
                if (cryptoMeta.priceToBeat !== undefined) {
                  this._deps.cryptoPriceStore.lockTargetPrice(cryptoMeta.rtdsFilter, cryptoMeta.priceToBeat);
                  this._logger.info('Strike price locked from meta (priceToBeat)', {
                    symbol: cryptoMeta.rtdsFilter,
                    strikePrice: cryptoMeta.priceToBeat,
                  });
                }
                if (cryptoMeta.finalPrice !== undefined) {
                  this._deps.cryptoPriceStore.lockResolutionPrice(cryptoMeta.rtdsFilter, cryptoMeta.finalPrice);
                  this._logger.info('Resolution price locked from meta (finalPrice)', {
                    symbol: cryptoMeta.rtdsFilter,
                    finalPrice: cryptoMeta.finalPrice,
                  });
                }
              }
            }

            this._logger.info('Meta loaded', {
              marketId: meta.marketId,
              tokenId,
              outcomeIndex,
            });
            continue;
          }

          // ── strike_price событие (обратная совместимость со старыми снапшотами) ──
          if (raw['t'] === 'strike_price' && this._deps.cryptoPriceStore) {
            const symbol = raw['symbol'] as string;
            const strikePrice = raw['strikePrice'] as number;
            if (symbol && typeof strikePrice === 'number') {
              this._deps.cryptoPriceStore.setTargetPrice(symbol, strikePrice);
              this._logger.info('Strike price loaded (legacy event)', {
                symbol,
                strikePrice,
              });
            }
            continue;
          }

          // ── crypto_price события (записанные collect-data) ──────────────
          // Реплеим ВСЕ цены (Chainlink + Binance) — стратегия сама выбирает source.
          if (raw['t'] === 'crypto_price' && this._deps.cryptoPriceStore) {
            const symbol = raw['symbol'] as string;
            const price = raw['price'] as number;
            const ts = raw['ts'] as number;
            if (symbol && typeof price === 'number' && typeof ts === 'number') {
              this._advanceClock(new Date(ts));
              this._deps.cryptoPriceStore.updatePrice(symbol, price, ts);

              // Обновляем resolution price только от Chainlink (Polymarket резолвит по нему).
              // Binance цена НЕ используется для определения исхода рынка.
              // Формат Chainlink: 'btc/usd', Binance: 'btcusdt'.
              if (symbol.includes('/')) {
                this._deps.cryptoPriceStore.setResolutionPrice(symbol, price);
              }

              cryptoPriceEvents++;
              continue;
            }
          }

          // ── market_resolved события ────────────────────────────────────────
          if (raw['t'] === 'market_resolved' && this._deps.cryptoPriceStore) {
            const symbol = raw['symbol'] as string;
            const strikePrice = raw['strikePrice'] as number;
            const resolutionPrice = raw['resolutionPrice'] as number;
            if (symbol && typeof strikePrice === 'number' && typeof resolutionPrice === 'number') {
              this._deps.cryptoPriceStore.lockTargetPrice(symbol, strikePrice);
              this._deps.cryptoPriceStore.lockResolutionPrice(symbol, resolutionPrice);
              this._logger.info('Market resolved event replayed (locked)', {
                symbol,
                strikePrice,
                resolutionPrice,
                outcome: raw['outcome'],
              });
            }
            continue;
          }

          // ── Определяем тип события ──────────────────────────────────────
          const eventType = raw['event_type'] as string | undefined;

          if (eventType === 'book' || eventType === 'last_trade_price') {
            // Формат collect-data
            if (!fileInstrumentId || !fileMarketId) continue;

            const assetId = raw['asset_id'] as string | undefined;
            const isPrimary = assetId === String(fileInstrumentId);
            const isComplementary = fileComplementaryId && assetId === String(fileComplementaryId);

            if (!isPrimary && !isComplementary) continue;

            if (eventType === 'book') {
              // Book events — только для основного токена
              if (!isPrimary) continue;
              const result = await this._processBookEvent(
                raw as unknown as RawBookEvent,
                fileInstrumentId,
                filePath,
              );
              if (result) bookEvents += 1;
              else {
                if (errors < 3) this._logger.warn('Book event processing failed', { timestamp: raw['timestamp'], assetId, bidsLen: (raw['bids'] as unknown[])?.length, asksLen: (raw['asks'] as unknown[])?.length });
                errors += 1;
              }
            } else {
              // Trade events — для обоих токенов
              const targetId = isPrimary ? fileInstrumentId : fileComplementaryId!;
              const result = await this._processTradeEvent(
                raw as unknown as RawTradeEvent,
                targetId,
                filePath,
              );
              if (result) tradeEvents += 1;
              else {
                if (errors < 3) this._logger.warn('Trade event processing failed', { timestamp: raw['timestamp'], price: raw['price'], size: raw['size'], side: raw['side'] });
                errors += 1;
              }
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
        complementaryInstrumentId = fileComplementaryId ?? complementaryInstrumentId;
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
      cryptoPriceEvents,
      errors,
      durationMs,
    });

    return {
      processedFiles,
      bookEvents,
      tradeEvents,
      cryptoPriceEvents,
      processedEvents,
      durationMs,
      errors,
      marketId,
      instrumentId,
      complementaryInstrumentId,
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
      // out-of-order timestamp — нормально при чередовании book/crypto_price событий
      this._logger.debug('ReplayClock: out-of-order event, skipping clock update');
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
