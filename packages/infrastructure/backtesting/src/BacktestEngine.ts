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
import * as fs from 'node:fs';
import * as path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import { asInstrumentId, asMarketId } from '@polymarket/ids';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import { Price, Quantity, TimestampService } from '@polymarket/value-objects';
import { OrderbookLevel } from '@polymarket/orderbook';
import type { Side } from '@polymarket/value-objects';
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

type ReplayCexVenue = 'binance' | 'coinbase' | 'okx' | 'cryptocom' | 'kraken';
type ReplayCexSide = 'buy' | 'sell';

interface ReplayCexFileMeta {
  readonly venue: ReplayCexVenue;
  readonly symbol: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

interface ReplayCexBookEvent {
  readonly kind: 'book';
  readonly venue: ReplayCexVenue;
  readonly symbol: string;
  readonly ts: number;
  readonly bids: readonly (readonly [number, number])[];
  readonly asks: readonly (readonly [number, number])[];
}

interface ReplayCexTradeEvent {
  readonly kind: 'trade';
  readonly venue: ReplayCexVenue;
  readonly symbol: string;
  readonly ts: number;
  readonly price: number;
  readonly size: number;
  readonly side?: ReplayCexSide;
}

type ReplayCexEvent = ReplayCexBookEvent | ReplayCexTradeEvent;

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
  /**
   * Реплеить соседние CEX файлы из структуры `date/{binance,okx,...}` рядом
   * с `date/polymarket/*.jsonl.gz`.
   *
   * @remarks
   * Старые collect-data CEX файлы хранят venue/symbol в имени файла, а записи
   * внутри имеют `t: "ob"` / `t: "trade"`. Этот режим превращает их в поток
   * `cryptoVenueState/cryptoVenueHistory` для стратегии.
   *
   * @defaultValue true
   */
  readonly replayCexSidecars?: boolean;
  /**
   * Сколько истории CEX загрузить до начала окна рынка.
   *
   * @defaultValue 30 минут
   */
  readonly cexWarmupMs?: number;
}

/**
 * Интерфейс strike/resolution-стора для BacktestEngine.
 *
 * @remarks
 * Минимальный интерфейс для передачи крипто-цен при реплее.
 */
/**
 * Strike/resolution-слой для реплея (реализуется `CryptoResolutionStore`).
 *
 * @remarks
 * Цены реплеятся в {@link IBacktestCryptoMarketDataStore} — единый источник
 * истины. Этот интерфейс хранит только lifecycle (strike/resolution).
 */
export interface IBacktestCryptoResolutionStore {
  setTargetPrice(symbolOrAsset: string, price: number): void;
  setResolutionPrice(symbolOrAsset: string, price: number): void;
  /** Устанавливает и блокирует targetPrice (priceToBeat из meta) от перезаписи */
  lockTargetPrice(symbolOrAsset: string, price: number): void;
  /** Устанавливает и блокирует resolutionPrice (finalPrice из meta) от перезаписи */
  lockResolutionPrice(symbolOrAsset: string, price: number): void;
}

export interface IBacktestCryptoMarketDataStore {
  updatePrice(
    input: {
      readonly symbol: string;
      readonly price: number;
      readonly timestampMs: number;
      readonly receivedTsMs?: number;
      readonly source?: 'polymarket_chainlink' | 'polymarket_binance' | 'chainlink' | 'binance';
    },
  ): void;
  updateCexBook(
    input: {
      readonly venue: 'binance' | 'coinbase' | 'okx' | 'cryptocom' | 'kraken';
      readonly symbol: string;
      readonly exchangeTsMs: number;
      readonly receivedTsMs?: number;
      readonly bids: readonly (readonly [number, number])[];
      readonly asks: readonly (readonly [number, number])[];
    },
  ): void;
  updateCexTrade(
    input: {
      readonly venue: 'binance' | 'coinbase' | 'okx' | 'cryptocom' | 'kraken';
      readonly symbol: string;
      readonly exchangeTsMs: number;
      readonly receivedTsMs?: number;
      readonly price: number;
      readonly size: number;
      readonly side?: 'buy' | 'sell';
    },
  ): void;
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
  /** Опциональный store strike/resolution для реплея lifecycle-событий */
  readonly cryptoResolutionStore?: IBacktestCryptoResolutionStore;
  /** Опциональный rolling history/state store для crypto/CEX replay. */
  readonly cryptoMarketDataStore?: IBacktestCryptoMarketDataStore;
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
  /** Количество обработанных CEX orderbook событий */
  readonly cexBookEvents: number;
  /** Количество обработанных CEX trade событий */
  readonly cexTradeEvents: number;
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
    let cexBookEvents = 0;
    let cexTradeEvents = 0;
    let errors = 0;
    let marketId: MarketId | undefined;
    let instrumentId: InstrumentId | undefined;
    let complementaryInstrumentId: InstrumentId | undefined;
    /** eventStartMs из meta — для определения strike по первой Chainlink цене */
    let fileEventStartMs: number | undefined;
    /** rtdsFilter из meta — символ для strike detection */
    let fileCryptoSymbol: string | undefined;
    /** Был ли strike уже lockнут (из priceToBeat или market_resolved) */
    let strikeLocked = false;

    for (const filePath of filePaths) {
      this._logger.debug('Processing snapshot file', { filePath });
      const readerFactory = new SnapshotReaderFactory(this._logger);
      const reader = readerFactory.create(filePath);

      let fileMarketId: MarketId | undefined;
      let fileInstrumentId: InstrumentId | undefined;
      let fileComplementaryId: InstrumentId | undefined;
      let fileCexEvents: ReplayCexEvent[] = [];
      let fileCexIndex = 0;
      let fileCexLoaded = false;
      const fileWindow = parsePolymarketSnapshotWindow(filePath);

      const drainCexUntil = (ts: number): void => {
        if (!this._deps.cryptoMarketDataStore || fileCexEvents.length === 0) return;
        while (fileCexIndex < fileCexEvents.length && fileCexEvents[fileCexIndex].ts <= ts) {
          const event = fileCexEvents[fileCexIndex++];
          this._advanceClock(new Date(event.ts));
          if (event.kind === 'book') {
            this._deps.cryptoMarketDataStore.updateCexBook({
              venue: event.venue,
              symbol: event.symbol,
              exchangeTsMs: event.ts,
              receivedTsMs: event.ts,
              bids: event.bids,
              asks: event.asks,
            });
            cexBookEvents += 1;
          } else {
            this._deps.cryptoMarketDataStore.updateCexTrade({
              venue: event.venue,
              symbol: event.symbol,
              exchangeTsMs: event.ts,
              receivedTsMs: event.ts,
              price: event.price,
              size: event.size,
              side: event.side,
            });
            cexTradeEvents += 1;
          }
        }
      };

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
            if (this._deps.cryptoResolutionStore && meta.m) {
              const cryptoMeta = this._deps.parseCryptoMeta?.(meta.m as Record<string, unknown>);
              if (cryptoMeta) {
                fileCryptoSymbol = cryptoMeta.rtdsFilter;
                // eventStartTime из rawMarket
                const rawEvtStart = (meta.m as Record<string, unknown>)['eventStartTime'] as string | undefined;
                if (rawEvtStart) fileEventStartMs = new Date(rawEvtStart).getTime();

                if (cryptoMeta.priceToBeat !== undefined) {
                  this._deps.cryptoResolutionStore.lockTargetPrice(cryptoMeta.rtdsFilter, cryptoMeta.priceToBeat);
                  strikeLocked = true;
                  this._logger.info('Strike price locked from meta (priceToBeat)', {
                    symbol: cryptoMeta.rtdsFilter,
                    strikePrice: cryptoMeta.priceToBeat,
                  });
                }
                if (cryptoMeta.finalPrice !== undefined) {
                  this._deps.cryptoResolutionStore.lockResolutionPrice(cryptoMeta.rtdsFilter, cryptoMeta.finalPrice);
                  this._logger.info('Resolution price locked from meta (finalPrice)', {
                    symbol: cryptoMeta.rtdsFilter,
                    finalPrice: cryptoMeta.finalPrice,
                  });
                }
              }
            }

            if (
              !fileCexLoaded &&
              this._deps.cryptoMarketDataStore &&
              (this._config.replayCexSidecars ?? true)
            ) {
              fileCexEvents = await this._loadCexSidecarEvents(filePath, fileWindow, fileEventStartMs);
              fileCexLoaded = true;
            }

            this._logger.info('Meta loaded', {
              marketId: meta.marketId,
              tokenId,
              outcomeIndex,
            });
            continue;
          }

          const rawEventTs = extractReplayTimestamp(raw);
          if (rawEventTs !== undefined) {
            drainCexUntil(rawEventTs);
          }

          // ── strike_price событие (обратная совместимость со старыми снапшотами) ──
          if (raw['t'] === 'strike_price' && this._deps.cryptoResolutionStore) {
            const symbol = raw['symbol'] as string;
            const strikePrice = raw['strikePrice'] as number;
            if (symbol && typeof strikePrice === 'number') {
              this._deps.cryptoResolutionStore.setTargetPrice(symbol, strikePrice);
              this._logger.info('Strike price loaded (legacy event)', {
                symbol,
                strikePrice,
              });
            }
            continue;
          }

          // ── crypto_price события (записанные collect-data) ──────────────
          // Реплеим ВСЕ цены (Chainlink + Binance) — стратегия сама выбирает source.
          if (raw['t'] === 'crypto_price' && (this._deps.cryptoResolutionStore || this._deps.cryptoMarketDataStore)) {
            const symbol = raw['symbol'] as string;
            const price = raw['price'] as number;
            const ts = raw['ts'] as number;
            if (symbol && typeof price === 'number' && typeof ts === 'number') {
              this._advanceClock(new Date(ts));
              // Цена — только в CryptoMarketDataStore (единый источник истины).
              this._deps.cryptoMarketDataStore?.updatePrice({
                symbol,
                price,
                timestampMs: ts,
                receivedTsMs: typeof raw['receivedTs'] === 'number' ? raw['receivedTs'] : ts,
                source: normalizeReplayCryptoSource(raw['source']),
              });

              // Обновляем resolution price только от Chainlink (Polymarket резолвит по нему).
              // Binance цена НЕ используется для определения исхода рынка.
              // Формат Chainlink: 'btc/usd', Binance: 'btcusdt'.
              if (symbol.includes('/') && this._deps.cryptoResolutionStore) {
                this._deps.cryptoResolutionStore.setResolutionPrice(symbol, price);

                // Авто-strike: первая Chainlink цена после eventStartTime = strike
                // (тот же подход что pendingChainlinkStrike в paper mode)
                if (!strikeLocked && fileEventStartMs && fileCryptoSymbol === symbol && ts >= fileEventStartMs) {
                  this._deps.cryptoResolutionStore.lockTargetPrice(symbol, price);
                  strikeLocked = true;
                  this._logger.info('Strike price auto-locked from first Chainlink price after eventStart', {
                    symbol,
                    strikePrice: price,
                    eventStartMs: fileEventStartMs,
                    priceTs: ts,
                  });
                }
              }

              cryptoPriceEvents++;
              continue;
            }
          }

          if (raw['t'] === 'cex_ob' && this._deps.cryptoMarketDataStore) {
            const venue = normalizeReplayVenue(raw['venue']);
            const symbol = raw['symbol'] as string;
            const exchangeTsMs = (raw['exchangeTs'] ?? raw['ts']) as number;
            const bids = raw['bids'] as readonly (readonly [number, number])[] | undefined;
            const asks = raw['asks'] as readonly (readonly [number, number])[] | undefined;
            if (venue && symbol && typeof exchangeTsMs === 'number' && bids && asks) {
              this._advanceClock(new Date(exchangeTsMs));
              this._deps.cryptoMarketDataStore.updateCexBook({
                venue,
                symbol,
                exchangeTsMs,
                receivedTsMs: typeof raw['receivedTs'] === 'number' ? raw['receivedTs'] : exchangeTsMs,
                bids,
                asks,
              });
              continue;
            }
          }

          if (raw['t'] === 'cex_trade' && this._deps.cryptoMarketDataStore) {
            const venue = normalizeReplayVenue(raw['venue']);
            const symbol = raw['symbol'] as string;
            const exchangeTsMs = (raw['exchangeTs'] ?? raw['ts']) as number;
            const price = raw['price'] as number;
            const size = raw['size'] as number;
            const side = normalizeReplayTradeSide(raw['side']);
            if (venue && symbol && typeof exchangeTsMs === 'number' && typeof price === 'number' && typeof size === 'number') {
              this._advanceClock(new Date(exchangeTsMs));
              this._deps.cryptoMarketDataStore.updateCexTrade({
                venue,
                symbol,
                exchangeTsMs,
                receivedTsMs: typeof raw['receivedTs'] === 'number' ? raw['receivedTs'] : exchangeTsMs,
                price,
                size,
                side,
              });
              continue;
            }
          }

          // ── market_resolved события ────────────────────────────────────────
          if (raw['t'] === 'market_resolved' && this._deps.cryptoResolutionStore) {
            const symbol = raw['symbol'] as string;
            const strikePrice = raw['strikePrice'] as number;
            const resolutionPrice = raw['resolutionPrice'] as number;
            if (symbol && typeof strikePrice === 'number' && typeof resolutionPrice === 'number') {
              this._deps.cryptoResolutionStore.lockTargetPrice(symbol, strikePrice);
              this._deps.cryptoResolutionStore.lockResolutionPrice(symbol, resolutionPrice);
              strikeLocked = true;
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
          // Поддерживаем оба формата: collect-data ('event_type') и raw WS ('type')
          const eventType = (raw['event_type'] ?? raw['type']) as string | undefined;

          if (eventType === 'book' || eventType === 'last_trade_price') {
            // Формат collect-data
            if (!fileInstrumentId || !fileMarketId) continue;

            const assetId = raw['asset_id'] as string | undefined;
            const isPrimary = assetId === String(fileInstrumentId);
            const isComplementary = fileComplementaryId && assetId === String(fileComplementaryId);

            if (!isPrimary && !isComplementary) continue;

            if (eventType === 'book') {
              // Book events: всегда для основного токена; для complementary —
              // только если включён replayComplementary (dual-token стратегии).
              const targetId = isPrimary ? fileInstrumentId : fileComplementaryId!;
              const result = await this._processBookEvent(
                raw as unknown as RawBookEvent,
                targetId,
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

        if (fileWindow) {
          drainCexUntil(fileWindow.windowEndMs);
        } else if (fileCexEvents.length > 0) {
          drainCexUntil(fileCexEvents[fileCexEvents.length - 1].ts);
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
      cexBookEvents,
      cexTradeEvents,
      errors,
      durationMs,
    });

    return {
      processedFiles,
      bookEvents,
      tradeEvents,
      cryptoPriceEvents,
      cexBookEvents,
      cexTradeEvents,
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
   * Загружает CEX sidecar-файлы, соответствующие polymarket snapshot-окну.
   *
   * @remarks
   * Не меняет состояние само по себе: только читает, нормализует и сортирует
   * события. Подача в store происходит через `drainCexUntil()` во время replay,
   * чтобы не было lookahead.
   */
  private async _loadCexSidecarEvents(
    polymarketFilePath: string,
    fileWindow: SnapshotWindow | undefined,
    eventStartMs: number | undefined,
  ): Promise<ReplayCexEvent[]> {
    const sidecarPlan = this._resolveCexSidecarPlan(polymarketFilePath, fileWindow, eventStartMs);
    if (!sidecarPlan) return [];

    const { snapshotDateDir, asset, fromMs, toMs } = sidecarPlan;
    const files = await this._findCexSidecarFiles(snapshotDateDir, asset, fromMs, toMs);
    if (files.length === 0) return [];

    const events: ReplayCexEvent[] = [];
    const readerFactory = new SnapshotReaderFactory(this._logger);

    for (const file of files) {
      const reader = readerFactory.create(file.filePath);
      try {
        for await (const line of reader.readLines()) {
          let raw: Record<string, unknown>;
          try {
            raw = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          const event = normalizeCexSidecarRecord(raw, file.meta);
          if (!event) continue;
          if (event.ts < fromMs || event.ts > toMs) continue;
          events.push(event);
        }
      } catch (err) {
        this._logger.warn('Failed to read CEX sidecar file', {
          filePath: file.filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await reader.close();
      }
    }

    events.sort((a, b) => a.ts !== b.ts ? a.ts - b.ts : cexEventOrder(a) - cexEventOrder(b));

    this._logger.debug('CEX sidecars loaded', {
      polymarketFile: path.basename(polymarketFilePath),
      asset,
      files: files.length,
      events: events.length,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    });

    return events;
  }

  private _resolveCexSidecarPlan(
    polymarketFilePath: string,
    fileWindow: SnapshotWindow | undefined,
    eventStartMs: number | undefined,
  ): { readonly snapshotDateDir: string; readonly asset: string; readonly fromMs: number; readonly toMs: number } | undefined {
    const polymarketDir = path.dirname(polymarketFilePath);

    const asset = inferCryptoAssetFromPolymarketFile(polymarketFilePath);
    if (!asset) return undefined;

    const snapshotDateDir = this._resolveCexSnapshotDateDir(polymarketDir);
    if (!snapshotDateDir) return undefined;

    const startMs = eventStartMs ?? fileWindow?.windowStartMs;
    const endMs = fileWindow?.windowEndMs;
    if (startMs === undefined || endMs === undefined) return undefined;

    const warmupMs = this._config.cexWarmupMs ?? 30 * 60 * 1000;
    return {
      snapshotDateDir,
      asset,
      fromMs: startMs - warmupMs,
      toMs: endMs,
    };
  }

  private _resolveCexSnapshotDateDir(polymarketDir: string): string | undefined {
    if (path.basename(polymarketDir) === 'polymarket') {
      return path.dirname(polymarketDir);
    }

    const dateDirName = path.basename(polymarketDir);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateDirName)) {
      const cexDateDir = path.join(path.dirname(polymarketDir), 'cex', dateDirName);
      if (fs.existsSync(cexDateDir)) return cexDateDir;
    }

    return undefined;
  }

  private async _findCexSidecarFiles(
    snapshotDateDir: string,
    asset: string,
    fromMs: number,
    toMs: number,
  ): Promise<Array<{ readonly filePath: string; readonly meta: ReplayCexFileMeta }>> {
    if (!fs.existsSync(snapshotDateDir)) return [];

    const result: Array<{ readonly filePath: string; readonly meta: ReplayCexFileMeta }> = [];
    const entries = await fs.promises.readdir(snapshotDateDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(snapshotDateDir, entry.name);
      if (!entry.isDirectory() && !(await isDirectoryLike(entryPath, entry))) continue;
      if (entry.name === 'polymarket') continue;
      const venue = normalizeReplayVenue(entry.name);
      if (!venue) continue;

      const venueDir = entryPath;
      let files: fs.Dirent[];
      try {
        files = await fs.promises.readdir(venueDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(venueDir, file.name);
        if (!file.isFile() && !(await isFileLike(filePath, file))) continue;
        if (!file.name.endsWith('.jsonl') && !file.name.endsWith('.jsonl.gz')) continue;

        const meta = parseCexSidecarFileName(file.name);
        if (!meta) continue;
        if (meta.venue !== venue) continue;
        if (assetFromCexSymbol(meta.symbol) !== asset) continue;
        if (!windowsOverlap(meta.windowStartMs, meta.windowEndMs, fromMs, toMs)) continue;

        result.push({ filePath, meta });
      }
    }

    result.sort((a, b) =>
      a.meta.windowStartMs !== b.meta.windowStartMs
        ? a.meta.windowStartMs - b.meta.windowStartMs
        : a.filePath.localeCompare(b.filePath),
    );

    return result;
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
    const result = await this._deps.eventBus.publish({
      type: 'TRADE_RECEIVED',
      instrumentId,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      price: price!,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      size: size!,
      side,
      timestamp: tsResult.value,
    });
    if (!result.ok) {
      this._logger.warn('TRADE_RECEIVED publish failed', { filePath, error: result.error.message });
      return false;
    }

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
   * Конвертирует raw уровни стакана в OrderbookLevel[] (Value Objects).
   *
   * @param levels - Массив { price, size } из JSON
   * @param filePath - Путь файла для логирования
   * @returns OrderbookLevel[] с Value Objects
   */
  private _convertLevels(
    levels: readonly RawLevel[],
    filePath: string,
  ): OrderbookLevel[] {
    const result: OrderbookLevel[] = [];
    for (const level of levels) {
      try {
        result.push(OrderbookLevel.create(
          Price.of(new Decimal(level.price)),
          Quantity.of(new Decimal(level.size)),
        ));
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

function normalizeReplayCryptoSource(
  source: unknown,
): 'polymarket_chainlink' | 'polymarket_binance' | 'chainlink' | 'binance' | undefined {
  if (source === 'polymarket_chainlink' || source === 'polymarket_binance') return source;
  if (source === 'chainlink' || source === 'binance') return source;
  return undefined;
}

function normalizeReplayVenue(
  venue: unknown,
): 'binance' | 'coinbase' | 'okx' | 'cryptocom' | 'kraken' | undefined {
  if (
    venue === 'binance' ||
    venue === 'coinbase' ||
    venue === 'okx' ||
    venue === 'cryptocom' ||
    venue === 'kraken'
  ) {
    return venue;
  }
  return undefined;
}

function normalizeReplayTradeSide(side: unknown): 'buy' | 'sell' | undefined {
  if (side === 'buy' || side === 'sell') return side;
  if (side === 'BUY') return 'buy';
  if (side === 'SELL') return 'sell';
  return undefined;
}

interface SnapshotWindow {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

function extractReplayTimestamp(raw: Record<string, unknown>): number | undefined {
  const ts = raw['ts'];
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;

  const exchangeTs = raw['exchangeTs'];
  if (typeof exchangeTs === 'number' && Number.isFinite(exchangeTs)) return exchangeTs;

  const timestamp = raw['timestamp'];
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp === 'string') {
    const parsed = Number(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

function parsePolymarketSnapshotWindow(filePath: string): SnapshotWindow | undefined {
  const fileName = path.basename(filePath);
  const match = fileName.match(/[-_](\d{4})_([A-Za-z]+)_(\d{1,2})_(\d{1,4}(?:AM|PM))-(\d{1,4}(?:AM|PM))_ET___/);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = MONTHS[match[2]!.toLowerCase()];
  const day = Number(match[3]);
  const start = parseEtClock(match[4]!);
  const end = parseEtClock(match[5]!);
  if (month === undefined || !start || !end) return undefined;

  const windowStartMs = zonedDateTimeToUtcMs(year, month, day, start.hour, start.minute);
  let windowEndMs = zonedDateTimeToUtcMs(year, month, day, end.hour, end.minute);
  if (windowEndMs <= windowStartMs) windowEndMs += 24 * 60 * 60 * 1000;

  return { windowStartMs, windowEndMs };
}

function parseCexSidecarFileName(fileName: string): ReplayCexFileMeta | undefined {
  const match = fileName.match(/^([a-z0-9]+)_([A-Za-z0-9-]+)_(?:spot|futures|swap)_(\d{4})-([A-Za-z]+)-(\d{1,2})_(\d{1,4}(?:AM|PM))-(\d{1,4}(?:AM|PM))_ET\.jsonl(?:\.gz)?$/);
  if (!match) return undefined;

  const venue = normalizeReplayVenue(match[1]);
  const symbol = match[2]?.replace('-', '/');
  const year = Number(match[3]);
  const month = MONTHS[match[4]!.toLowerCase()];
  const day = Number(match[5]);
  const start = parseEtClock(match[6]!);
  const end = parseEtClock(match[7]!);
  if (!venue || !symbol || month === undefined || !start || !end) return undefined;

  const windowStartMs = zonedDateTimeToUtcMs(year, month, day, start.hour, start.minute);
  let windowEndMs = zonedDateTimeToUtcMs(year, month, day, end.hour, end.minute);
  if (windowEndMs <= windowStartMs) windowEndMs += 24 * 60 * 60 * 1000;

  return {
    venue,
    symbol,
    windowStartMs,
    windowEndMs,
  };
}

function normalizeCexSidecarRecord(raw: Record<string, unknown>, meta: ReplayCexFileMeta): ReplayCexEvent | undefined {
  const ts = raw['ts'];
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined;

  if (raw['t'] === 'ob') {
    const bids = normalizeCexLevels(raw['bids']);
    const asks = normalizeCexLevels(raw['asks']);
    if (!bids || !asks) return undefined;

    return {
      kind: 'book',
      venue: meta.venue,
      symbol: meta.symbol,
      ts,
      bids,
      asks,
    };
  }

  if (raw['t'] === 'trade') {
    const price = typeof raw['p'] === 'number' ? raw['p'] : typeof raw['price'] === 'number' ? raw['price'] : undefined;
    const size = typeof raw['sz'] === 'number' ? raw['sz'] : typeof raw['size'] === 'number' ? raw['size'] : undefined;
    if (price === undefined || size === undefined || !Number.isFinite(price) || !Number.isFinite(size)) return undefined;

    return {
      kind: 'trade',
      venue: meta.venue,
      symbol: meta.symbol,
      ts,
      price,
      size,
      side: normalizeReplayTradeSide(raw['side']),
    };
  }

  return undefined;
}

function normalizeCexLevels(raw: unknown): readonly (readonly [number, number])[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const levels: Array<readonly [number, number]> = [];
  for (const value of raw) {
    if (!Array.isArray(value) || value.length < 2) return undefined;
    const price = typeof value[0] === 'number' ? value[0] : Number(value[0]);
    const size = typeof value[1] === 'number' ? value[1] : Number(value[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return undefined;
    levels.push([price, size]);
  }

  return levels;
}

function inferCryptoAssetFromPolymarketFile(filePath: string): string | undefined {
  const lower = path.basename(filePath).toLowerCase();
  if (lower.includes('bitcoin') || lower.includes('_btc_')) return 'btc';
  if (lower.includes('ethereum') || lower.includes('_eth_')) return 'eth';
  if (lower.includes('solana') || lower.includes('_sol_')) return 'sol';
  if (lower.includes('xrp')) return 'xrp';
  return undefined;
}

function assetFromCexSymbol(symbol: string): string {
  const base = symbol.toLowerCase().split(/[/-]/)[0] ?? '';
  if (base === 'xbt') return 'btc';
  return base;
}

function windowsOverlap(leftStartMs: number, leftEndMs: number, rightStartMs: number, rightEndMs: number): boolean {
  return leftStartMs <= rightEndMs && leftEndMs >= rightStartMs;
}

function cexEventOrder(event: ReplayCexEvent): number {
  return event.kind === 'book' ? 0 : 1;
}

async function isDirectoryLike(filePath: string, entry: fs.Dirent): Promise<boolean> {
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await fs.promises.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function isFileLike(filePath: string, entry: fs.Dirent): Promise<boolean> {
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function parseEtClock(raw: string): { readonly hour: number; readonly minute: number } | undefined {
  const suffix = raw.slice(-2);
  const digits = raw.slice(0, -2);
  if ((suffix !== 'AM' && suffix !== 'PM') || !/^\d{1,4}$/.test(digits)) return undefined;

  const minute = digits.length > 2 ? Number(digits.slice(-2)) : 0;
  let hour = digits.length > 2 ? Number(digits.slice(0, -2)) : Number(digits);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return undefined;

  if (suffix === 'AM') {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }

  return { hour, minute };
}

function zonedDateTimeToUtcMs(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = 'America/New_York',
): number {
  let utcMs = Date.UTC(year, monthIndex, day, hour, minute);
  const targetAsUtc = Date.UTC(year, monthIndex, day, hour, minute);

  for (let iteration = 0; iteration < 4; iteration++) {
    const zoned = getZonedParts(utcMs, timeZone);
    const zonedAsUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute);
    const delta = targetAsUtc - zonedAsUtc;
    if (delta === 0) break;
    utcMs += delta;
  }

  return utcMs;
}

function getZonedParts(
  utcMs: number,
  timeZone: string,
): { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcMs));

  const get = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? NaN : Number(value);
  };

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}
