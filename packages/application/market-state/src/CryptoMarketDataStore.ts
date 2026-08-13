/**
 * Long-lived crypto market data store.
 *
 * @remarks
 * This store is asset-scoped, not market-scoped. BTC history survives rotation
 * between 5-minute Polymarket markets, while per-market strike/resolution data
 * stays in the strategy registration / cryptoPrice snapshot layer.
 */

import type { ILogger } from '@polymarket/logger';

/**
 * Источник цены базового крипто-актива.
 *
 * @remarks
 * `polymarket_*` — цены, которые сам Polymarket использует для резолюции рынка
 * (Chainlink-оракул, Binance-фид); `cex_*` — сырые цены с внешних бирж,
 * используемые для сигналов (lead-lag, дивергенция), не для резолюции.
 */
export type CryptoPriceSource =
  | 'polymarket_chainlink'
  | 'polymarket_binance'
  | 'cex_binance'
  | 'cex_coinbase'
  | 'cex_okx'
  | 'cex_cryptocom'
  | 'cex_kraken';

/** Идентификатор CEX-биржи, с которой стор собирает сырые стаканы/трейды. */
export type CexVenue = 'binance' | 'coinbase' | 'okx' | 'cryptocom' | 'kraken';

/** Причина изменения, передаваемая в колбэк подписчика стора. */
export type CryptoMarketDataReason = 'CRYPTO_PRICE' | 'CRYPTO_MARKET_DATA';

/**
 * Единичное наблюдение цены базового актива из одного источника.
 *
 * @remarks
 * `price`/`exchangeTsMs`/`receivedTsMs` — сырые `number` намеренно, не VO:
 * это per-tick горячий путь (реплей бэктеста и живой сбор CEX-данных
 * вызывают апдейт на каждое WS-событие), а `price` — крипто-спот-цена
 * произвольного масштаба (например, ~78000 для BTC), несовместимая с
 * диапазоном `Price` VO (`[0.0001, 0.9999]`, вероятностная цена
 * prediction-market). См. `docs/market-state.md` за полным обоснованием.
 */
export interface CryptoPricePoint {
  readonly asset: string;
  readonly source: CryptoPriceSource;
  readonly price: number;
  readonly exchangeTsMs: number;
  readonly receivedTsMs: number;
}

/**
 * Снапшот верхних уровней стакана одной CEX-биржи в один момент времени.
 *
 * @remarks
 * Обрезан до `maxBookLevels` уровней (см. {@link CryptoMarketDataStoreConfig.maxBookLevels}).
 * Числовые поля — тот же per-tick hot-path, что {@link CryptoPricePoint}.
 */
export interface CexBookTick {
  readonly asset: string;
  readonly venue: CexVenue;
  readonly symbol: string;
  readonly exchangeTsMs: number;
  readonly receivedTsMs: number;
  /** Уровни bid (price, size). Обрезаны до `maxBookLevels` уровней (#4). */
  readonly bids: readonly (readonly [number, number])[];
  /** Уровни ask (price, size). Обрезаны до `maxBookLevels` уровней (#4). */
  readonly asks: readonly (readonly [number, number])[];
}

/**
 * Единичная сделка на CEX-бирже.
 *
 * @remarks
 * `side` опционален — не все венды/фиды несут сторону агрессора для каждой сделки.
 */
export interface CexTradeTick {
  readonly asset: string;
  readonly venue: CexVenue;
  readonly symbol: string;
  readonly exchangeTsMs: number;
  readonly receivedTsMs: number;
  readonly price: number;
  readonly size: number;
  readonly side?: 'buy' | 'sell';
}

/**
 * Производное состояние одной CEX-биржи «на сейчас» — top-of-book +
 * простые метрики (mid/microprice/spread/imbalance/trade pressure).
 *
 * @remarks
 * Пересчитывается на каждом апдейте книги/трейда (`updateCexBook`/`updateCexTrade`)
 * из последних `CexBookTick`/`CexTradeTick` — не хранит собственную историю.
 */
export interface CexVenueState {
  readonly asset: string;
  readonly venue: CexVenue;
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  readonly mid: number;
  readonly microprice: number;
  readonly spreadBps: number;
  readonly imbalanceTop: number;
  readonly lastBookTsMs: number;
  readonly lastReceivedTsMs: number;
  readonly recentTradePressure: number;
}

/**
 * Read-only представление истории цен одного актива по всем источникам.
 *
 * @remarks
 * Возвращается `getPriceHistory()` — сам стор не выставляет мутирующие методы
 * наружу, только этот view.
 */
export interface CryptoPriceHistoryView {
  readonly asset: string;
  /**
   * Последний известный тик источника (`at(-1)`), **без гарантии свежести** —
   * возраст не проверяется. Для проверки актуальности используйте `getNearest`/
   * `getRecent` с `nowMs` или сверяйте `exchangeTsMs` самостоятельно.
   */
  getLatest(source: CryptoPriceSource): CryptoPricePoint | undefined;
  /**
   * Возвращает точки за последние `lookbackMs` миллисекунд.
   *
   * @param source - Источник цены
   * @param lookbackMs - Длина окна (мс)
   * @param nowMs - Опорное время (epoch ms). Если задано — окно `[nowMs - lookbackMs, nowMs]`
   *   с верхней границей (защита от look-ahead и от привязки к устаревшему последнему тику).
   *   Если не задано — окно отсчитывается от timestamp последнего тика источника (legacy-режим).
   */
  getRecent(source: CryptoPriceSource, lookbackMs: number, nowMs?: number): readonly CryptoPricePoint[];
  getMerged(sources: readonly CryptoPriceSource[], lookbackMs: number, nowMs?: number): readonly CryptoPricePoint[];
  /**
   * Точка, ближайшая по времени к `tsMs`, в пределах `maxDistanceMs`.
   *
   * @param source - Источник цены
   * @param tsMs - Целевой момент (epoch ms)
   * @param maxDistanceMs - Макс. допустимое отклонение от `tsMs`
   * @returns Ближайшая точка или `undefined`, если в пределах допуска ничего нет
   *
   * @remarks
   * Корректный способ взять цену «примерно X мс назад» (для momentum), в отличие
   * от `getRecent(...)[0]`, который вернул бы самую раннюю точку окна (#9).
   */
  getNearest(source: CryptoPriceSource, tsMs: number, maxDistanceMs: number): CryptoPricePoint | undefined;
  /**
   * Точка с timestamp ≤ `tsMs`, ближайшая к нему снизу, в пределах `maxDistanceMs`.
   *
   * @remarks
   * Для momentum правильнее, чем {@link getNearest}: берёт цену «до или в момент»
   * `tsMs`, а не ближайшую с любой стороны (которая при редкой истории могла бы
   * оказаться сильно ближе к настоящему и занизить momentum) (#9).
   */
  getNearestBeforeOrAt(source: CryptoPriceSource, tsMs: number, maxDistanceMs: number): CryptoPricePoint | undefined;
}

/**
 * Read-only представление текущего состояния всех CEX-венью одного актива.
 *
 * @remarks
 * Возвращается `getVenueState()`.
 */
export interface CryptoVenueStateView {
  readonly asset: string;
  get(venue: CexVenue): CexVenueState | undefined;
  getAll(): readonly CexVenueState[];
}

/**
 * Read-only представление истории книг/трейдов одного актива по всем венью.
 *
 * @remarks
 * Возвращается `getVenueHistory()`.
 */
export interface CryptoVenueHistoryView {
  readonly asset: string;
  /**
   * @param nowMs - Опорное время (epoch ms). См. {@link CryptoPriceHistoryView.getRecent}
   *   — задаёт окно `[nowMs - lookbackMs, nowMs]` с верхней границей.
   */
  getRecentBooks(venue: CexVenue, lookbackMs: number, nowMs?: number): readonly CexBookTick[];
  getRecentTrades(venue: CexVenue, lookbackMs: number, nowMs?: number): readonly CexTradeTick[];
}

/**
 * Конфигурация `CryptoMarketDataStore` — все поля опциональны, с разумными
 * по умолчанию (см. константы `DEFAULT_*` в этом файле).
 */
export interface CryptoMarketDataStoreConfig {
  readonly priceRetentionMs?: number;
  readonly bookRetentionMs?: number;
  readonly tradeRetentionMs?: number;
  readonly tradePressureLookbackMs?: number;
  /**
   * Emit CRYPTO_MARKET_DATA changes for raw CEX book/trade updates.
   *
   * @remarks
   * Default is false because raw CEX streams can produce thousands of updates
   * per minute. Strategies should normally react to material derived signals,
   * while still reading fresh CEX history/state from this store.
   *
   * @remarks
   * Если `true` — «сырой» режим: уведомление на каждом апдейте (шумно).
   * Для умного слоя используйте {@link materialMoveBps} вместо этого флага.
   */
  readonly notifyCexChanges?: boolean;
  /**
   * Порог материального движения microprice для уведомления (bps) (#7).
   *
   * @remarks
   * Промежуточный слой между «тишиной» (notifyCexChanges=false) и «шумом»
   * (=true): CEX-апдейт будит стратегию (`CRYPTO_MARKET_DATA`) только если
   * microprice сдвинулся ≥ этого порога с прошлого уведомления И прошло
   * ≥ {@link materialMoveMinIntervalMs}. Так ловится lead-lag edge без захлёба
   * scheduler. `0` (default) — слой выключен (поведение как раньше).
   */
  readonly materialMoveBps?: number;
  /**
   * Минимальный интервал между материальными уведомлениями (ms) (#7).
   * По умолчанию {@link DEFAULT_MATERIAL_MOVE_MIN_INTERVAL_MS}.
   */
  readonly materialMoveMinIntervalMs?: number;
  /**
   * Порог нотионала одиночного трейда (USD) для material-уведомления (#8).
   *
   * @remarks
   * Связывает trade-pressure с триггером: крупный трейд (`price*size >= порог`)
   * будит стратегию (`CRYPTO_MARKET_DATA`) даже без движения book microprice,
   * с тем же интервальным гейтом {@link materialMoveMinIntervalMs}.
   * `0` (default) — выключено.
   */
  readonly materialTradeNotional?: number;
  /**
   * Максимальное опережение `exchangeTsMs` относительно `receivedTsMs` (мс).
   *
   * @remarks
   * Защита от битых «будущих» timestamp, которые при prune (отсечение по
   * `latestTs - retention`) могут вычистить всю реальную историю. Тик с
   * `exchangeTsMs > receivedTsMs + maxFutureSkewMs` отбраковывается.
   * По умолчанию {@link DEFAULT_MAX_FUTURE_SKEW_MS}.
   */
  readonly maxFutureSkewMs?: number;
  /**
   * Логгер для диагностики отбракованных тиков (опционально).
   *
   * @remarks
   * Если не задан — отбраковка тихая, но счётчик {@link CryptoMarketDataStore.rejectedTickCount}
   * всё равно инкрементируется.
   */
  readonly logger?: ILogger;
  /**
   * Сколько уровней стакана хранить в `CexBookTick` (#4).
   *
   * @remarks
   * Полный стакан CEX (до 50+ уровней) × частота × retention быстро раздувает
   * память. Деривативы (mid/microprice/spread/imbalance) считаются по top-of-book,
   * а потребителям глубины (OrderBookWall) хватает узкой полосы у вершины.
   * По умолчанию {@link DEFAULT_MAX_BOOK_LEVELS}.
   */
  readonly maxBookLevels?: number;
  /**
   * Жёсткий потолок числа элементов в каждом массиве истории (#M3).
   *
   * @remarks
   * Дополняет `maxAgeMs`-retention count-cap'ом: при высокочастотном CEX-потоке
   * (5 бирж × ~100/с × 30 мин) массивы иначе растут в сотни тысяч элементов.
   * После prune по времени массив дополнительно режется до `maxHistoryCount`
   * (удаляются самые старые). По умолчанию {@link DEFAULT_MAX_HISTORY_COUNT}.
   */
  readonly maxHistoryCount?: number;
}

/**
 * Вход `updatePrice()` — одно наблюдение цены из источника резолюции
 * (Chainlink/Binance через сам Polymarket).
 *
 * @remarks
 * `asset` опционален — если не задан, выводится из `symbol` через
 * `inferAssetFromSymbol()`. `source` принимает короткие алиасы (`'chainlink'`,
 * `'binance'`) в дополнение к полным `CryptoPriceSource`-значениям — маппятся
 * на `polymarket_chainlink`/`polymarket_binance` внутри.
 */
export interface UpdateCryptoPriceInput {
  readonly symbol: string;
  readonly price: number;
  readonly timestampMs: number;
  readonly receivedTsMs?: number;
  readonly asset?: string;
  readonly source?: CryptoPriceSource | 'chainlink' | 'binance';
}

/**
 * Вход `updateCexBook()` — снапшот стакана одной CEX-биржи.
 *
 * @remarks
 * `bids`/`asks` обрезаются до `maxBookLevels` внутри стора — вызывающий может
 * передать полный стакан, лишние уровни просто отбрасываются.
 */
export interface UpdateCexBookInput {
  readonly venue: CexVenue;
  readonly symbol: string;
  readonly exchangeTsMs: number;
  readonly receivedTsMs?: number;
  readonly asset?: string;
  readonly bids: readonly (readonly [number, number])[];
  readonly asks: readonly (readonly [number, number])[];
}

/** Вход `updateCexTrade()` — одна сделка на CEX-бирже. */
export interface UpdateCexTradeInput {
  readonly venue: CexVenue;
  readonly symbol: string;
  readonly exchangeTsMs: number;
  readonly receivedTsMs?: number;
  readonly asset?: string;
  readonly price: number;
  readonly size: number;
  readonly side?: 'buy' | 'sell';
}

const DEFAULT_RETENTION_MS = 30 * 60_000;
const DEFAULT_TRADE_PRESSURE_LOOKBACK_MS = 1_000;
const DEFAULT_MAX_FUTURE_SKEW_MS = 5_000;
/**
 * Сколько уровней стакана хранить по умолчанию в каждом `CexBookTick` (#4).
 *
 * @remarks
 * 20 уровней с запасом покрывают узкую полосу у вершины (OrderBookWall) и
 * ограничивают память против полного стакана на 30 минут retention.
 */
const DEFAULT_MAX_BOOK_LEVELS = 20;
/**
 * Потолок числа элементов в массиве истории по умолчанию (#M3).
 *
 * @remarks
 * ~50k тиков на (asset, source/venue) — щедро для 30-мин ретеншена на нормальной
 * частоте, но ограничивает память при патологическом потоке.
 */
const DEFAULT_MAX_HISTORY_COUNT = 50_000;
/** Минимальный интервал между материальными CEX-уведомлениями по умолчанию (ms) (#7). */
const DEFAULT_MATERIAL_MOVE_MIN_INTERVAL_MS = 50;
/**
 * Нижняя граница правдоподобного epoch-ms timestamp (2001-09-09).
 *
 * @remarks
 * Отсекает timestamp в секундах (~1.7e9) и прочий мусор, который иначе
 * вставился бы как «очень старый» тик.
 */
const MIN_PLAUSIBLE_EPOCH_MS = 1_000_000_000_000;

/**
 * Long-lived хранилище цен базового крипто-актива и сырых CEX-стаканов/трейдов.
 *
 * @remarks
 * Asset-scoped (BTC/ETH/...), не market-scoped — история актива переживает
 * ротацию 5-минутных Polymarket-рынков (см. TSDoc модуля вверху файла).
 *
 * Числовые поля всех входов/представлений (`price`, `exchangeTsMs`,
 * `receivedTsMs`, `bids`/`asks`) — намеренно `number`, не VO (`Price`/
 * `Timestamp`): это per-tick hot-path (реплей бэктеста и живой сбор
 * CEX-данных пишут на каждое WS-событие через `updatePrice`/`updateCexBook`/
 * `updateCexTrade`), а крипто-спот-цена несовместима с диапазоном `Price` VO.
 * Полное обоснование — `docs/market-state.md`.
 *
 * @example
 * ```typescript
 * const store = new CryptoMarketDataStore({ logger });
 * store.updatePrice({ symbol: 'BTC/USD', price: 78_237, timestampMs: Date.now() });
 * store.updateCexBook({ venue: 'binance', symbol: 'BTCUSDT', exchangeTsMs: Date.now(), bids, asks });
 *
 * const history = store.getPriceHistory('btc');
 * const latest = history?.getLatest('polymarket_chainlink');
 * ```
 */
export class CryptoMarketDataStore {
  private readonly _priceRetentionMs: number;
  private readonly _bookRetentionMs: number;
  private readonly _tradeRetentionMs: number;
  private readonly _tradePressureLookbackMs: number;
  private readonly _notifyCexChanges: boolean;
  private readonly _materialMoveBps: number;
  private readonly _materialMoveMinIntervalMs: number;
  private readonly _materialTradeNotional: number;
  private readonly _maxFutureSkewMs: number;
  private readonly _maxBookLevels: number;
  private readonly _maxHistoryCount: number;
  private readonly _logger: ILogger | undefined;
  private _rejectedTickCount = 0;
  /** Точка отсчёта материального движения book per (asset, venue) (#7). */
  private readonly _lastCexNotify = new Map<string, Map<CexVenue, { tsMs: number; refMicroprice: number }>>();
  /** Время последнего trade-notify per (asset, venue) для интервального гейта (#8). */
  private readonly _lastTradeNotify = new Map<string, Map<CexVenue, number>>();

  private readonly _prices = new Map<string, Map<CryptoPriceSource, CryptoPricePoint[]>>();
  private readonly _books = new Map<string, Map<CexVenue, CexBookTick[]>>();
  private readonly _trades = new Map<string, Map<CexVenue, CexTradeTick[]>>();
  private readonly _venueStates = new Map<string, Map<CexVenue, CexVenueState>>();
  private _onChange?: (asset: string, reason: CryptoMarketDataReason) => void;

  constructor(config: CryptoMarketDataStoreConfig = {}) {
    this._logger = config.logger?.child({ component: 'CryptoMarketDataStore' });
    // #U2: валидация конфига — NaN/Inf/<=0 в retention/skew иначе отключили бы
    // pruning, снесли бы историю или отбраковали все тики. Чиним → default + warn.
    const log = this._logger;
    this._priceRetentionMs = sanitizePositiveMs(config.priceRetentionMs, DEFAULT_RETENTION_MS, log, 'priceRetentionMs');
    this._bookRetentionMs = sanitizePositiveMs(config.bookRetentionMs, DEFAULT_RETENTION_MS, log, 'bookRetentionMs');
    this._tradeRetentionMs = sanitizePositiveMs(config.tradeRetentionMs, DEFAULT_RETENTION_MS, log, 'tradeRetentionMs');
    this._tradePressureLookbackMs = sanitizePositiveMs(config.tradePressureLookbackMs, DEFAULT_TRADE_PRESSURE_LOOKBACK_MS, log, 'tradePressureLookbackMs');
    this._notifyCexChanges = config.notifyCexChanges ?? false;
    this._materialMoveBps = sanitizeNonNegative(config.materialMoveBps, 0, log, 'materialMoveBps');
    this._materialMoveMinIntervalMs = sanitizeNonNegative(config.materialMoveMinIntervalMs, DEFAULT_MATERIAL_MOVE_MIN_INTERVAL_MS, log, 'materialMoveMinIntervalMs');
    this._materialTradeNotional = sanitizeNonNegative(config.materialTradeNotional, 0, log, 'materialTradeNotional');
    this._maxFutureSkewMs = sanitizeNonNegative(config.maxFutureSkewMs, DEFAULT_MAX_FUTURE_SKEW_MS, log, 'maxFutureSkewMs');
    this._maxBookLevels = sanitizeCount(config.maxBookLevels, DEFAULT_MAX_BOOK_LEVELS, log, 'maxBookLevels');
    this._maxHistoryCount = sanitizeCount(config.maxHistoryCount, DEFAULT_MAX_HISTORY_COUNT, log, 'maxHistoryCount');
  }

  setOnChange(cb: (asset: string, reason: CryptoMarketDataReason) => void): void {
    this._onChange = cb;
  }

  /**
   * Количество отбракованных по timestamp-guard тиков с момента создания.
   *
   * @returns Счётчик отбракованных тиков (price + book + trade)
   *
   * @remarks
   * Используется для наблюдаемости и тестов: ненулевое значение указывает на
   * проблемный источник (битые timestamp, рассинхрон часов, неверная единица).
   */
  rejectedTickCount(): number {
    return this._rejectedTickCount;
  }

  updatePrice(input: UpdateCryptoPriceInput): void {
    if (!Number.isFinite(input.price) || input.price <= 0) return;

    const asset = normalizeAsset(input.asset ?? inferAssetFromSymbol(input.symbol));
    if (!asset) return;

    const receivedTsMs = input.receivedTsMs ?? Date.now();
    if (!this._acceptTimestamp(input.timestampMs, receivedTsMs, 'price', input.symbol)) return;

    const source = normalizePriceSource(input.source, input.symbol);
    const point: CryptoPricePoint = {
      asset,
      source,
      price: input.price,
      exchangeTsMs: input.timestampMs,
      receivedTsMs,
    };

    const sourceMap = getOrCreateNestedMap(this._prices, asset);
    const history = getOrCreateArray(sourceMap, source);
    const isLatest = insertSortedUniqueByTimestamp(history, point, (item) => item.exchangeTsMs);
    const latestTs = history.at(-1)?.exchangeTsMs ?? point.exchangeTsMs;
    pruneAndCap(history, latestTs - this._priceRetentionMs, this._maxHistoryCount, (item) => item.exchangeTsMs);

    if (isLatest) {
      this._onChange?.(asset, 'CRYPTO_PRICE');
    }
  }

  updateCexBook(input: UpdateCexBookInput): void {
    if (input.bids.length === 0 || input.asks.length === 0) return;

    const asset = normalizeAsset(input.asset ?? inferAssetFromSymbol(input.symbol));
    if (!asset) return;

    // #8 + #10: отсеиваем мусорные уровни (NaN/Inf/≤0) и сортируем — best bid/ask
    // и деривативы не зависят ни от порядка, ни от битых size/price.
    const bids = normalizeLevels(input.bids, 'desc');
    const asks = normalizeLevels(input.asks, 'asc');
    if (bids.length === 0 || asks.length === 0) return;

    const bid = bids[0]![0];
    const ask = asks[0]![0];
    const bidSize = bids[0]![1];
    const askSize = asks[0]![1];
    if (ask < bid) return; // скрещенный стакан — мусор

    const receivedTsMs = input.receivedTsMs ?? Date.now();
    if (!this._acceptTimestamp(input.exchangeTsMs, receivedTsMs, 'book', input.symbol)) return;

    const tick: CexBookTick = {
      asset,
      venue: input.venue,
      symbol: input.symbol,
      exchangeTsMs: input.exchangeTsMs,
      receivedTsMs,
      // #4: храним только top-N уровней (память), деривативы ниже считаем по top-of-book.
      bids: bids.slice(0, this._maxBookLevels),
      asks: asks.slice(0, this._maxBookLevels),
    };

    const bookMap = getOrCreateNestedMap(this._books, asset);
    const bookHistory = getOrCreateArray(bookMap, input.venue);
    const isLatest = insertSortedUniqueByTimestamp(bookHistory, tick, (item) => item.exchangeTsMs);
    const latestTs = bookHistory.at(-1)?.exchangeTsMs ?? tick.exchangeTsMs;
    pruneAndCap(bookHistory, latestTs - this._bookRetentionMs, this._maxHistoryCount, (item) => item.exchangeTsMs);

    // Деривативы считаем до out-of-order ветки, чтобы #M2: в price-history писать
    // microprice (а не mid) в обоих путях — иначе серия цен биржи смешивала бы их.
    const mid = (bid + ask) / 2;
    const sizeSum = bidSize + askSize;
    const microprice = sizeSum > 0 ? (ask * bidSize + bid * askSize) / sizeSum : mid;
    const spreadBps = ((ask - bid) / mid) * 10_000;
    const imbalanceTop = sizeSum > 0 ? (bidSize - askSize) / sizeSum : 0;

    const existingState = this._venueStates.get(asset)?.get(input.venue);
    if (existingState && input.exchangeTsMs < existingState.lastBookTsMs) {
      // Out-of-order тик: не регрессируем venue-state, но microprice в историю пишем.
      this._recordVenuePrice(asset, input.venue, microprice, input.exchangeTsMs, receivedTsMs);
      return;
    }

    getOrCreateNestedMap(this._venueStates, asset).set(input.venue, {
      asset,
      venue: input.venue,
      symbol: input.symbol,
      bid,
      ask,
      mid,
      microprice,
      spreadBps,
      imbalanceTop,
      lastBookTsMs: input.exchangeTsMs,
      lastReceivedTsMs: receivedTsMs,
      recentTradePressure: this._computeRecentTradePressure(asset, input.venue, input.exchangeTsMs),
    });

    this._recordVenuePrice(asset, input.venue, microprice, input.exchangeTsMs, receivedTsMs);
    if (!isLatest) return;
    if (this._notifyCexChanges) {
      this._onChange?.(asset, 'CRYPTO_MARKET_DATA');
      return;
    }
    this._maybeNotifyCexMove(asset, input.venue, microprice, input.exchangeTsMs);
  }

  updateCexTrade(input: UpdateCexTradeInput): void {
    if (!Number.isFinite(input.price) || input.price <= 0 || !Number.isFinite(input.size) || input.size <= 0) {
      return;
    }

    const asset = normalizeAsset(input.asset ?? inferAssetFromSymbol(input.symbol));
    if (!asset) return;

    const receivedTsMs = input.receivedTsMs ?? Date.now();
    if (!this._acceptTimestamp(input.exchangeTsMs, receivedTsMs, 'trade', input.symbol)) return;

    const tick: CexTradeTick = {
      asset,
      venue: input.venue,
      symbol: input.symbol,
      exchangeTsMs: input.exchangeTsMs,
      receivedTsMs,
      price: input.price,
      size: input.size,
      side: input.side,
    };

    const tradeMap = getOrCreateNestedMap(this._trades, asset);
    const tradeHistory = getOrCreateArray(tradeMap, input.venue);
    // Трейды НЕ дедуплицируются по timestamp: несколько сделок часто имеют
    // одинаковый exchangeTsMs (мс), unique-replace терял бы данные (#5).
    const isLatest = insertSortedAllowDuplicates(tradeHistory, tick, (item) => item.exchangeTsMs);
    const latestTs = tradeHistory.at(-1)?.exchangeTsMs ?? tick.exchangeTsMs;
    pruneAndCap(tradeHistory, latestTs - this._tradeRetentionMs, this._maxHistoryCount, (item) => item.exchangeTsMs);

    const venueState = this._venueStates.get(asset)?.get(input.venue);
    if (venueState && input.exchangeTsMs >= venueState.lastBookTsMs) {
      this._venueStates.get(asset)!.set(input.venue, {
        ...venueState,
        recentTradePressure: this._computeRecentTradePressure(asset, input.venue, input.exchangeTsMs),
      });
    }

    if (!isLatest) return;
    if (this._notifyCexChanges) {
      this._onChange?.(asset, 'CRYPTO_MARKET_DATA');
      return;
    }
    // #8: крупный трейд будит стратегию даже без движения book microprice.
    this._maybeNotifyTrade(asset, input.venue, input.price * input.size, input.exchangeTsMs);
  }

  getPriceHistory(symbolOrAsset: string): CryptoPriceHistoryView | undefined {
    const asset = normalizeAsset(inferAssetFromSymbol(symbolOrAsset));
    const sourceMap = this._prices.get(asset);
    if (!sourceMap) return undefined;

    return {
      asset,
      getLatest: (source) => sourceMap.get(source)?.at(-1),
      getRecent: (source, lookbackMs, nowMs) => {
        const history = sourceMap.get(source) ?? [];
        const anchor = nowMs ?? history.at(-1)?.exchangeTsMs;
        if (anchor === undefined) return [];
        return windowByTimestamp(history, anchor - lookbackMs, anchor, (item) => item.exchangeTsMs);
      },
      getMerged: (sources, lookbackMs, nowMs) => {
        const anchor = nowMs ?? Math.max(
          ...sources.map((source) => sourceMap.get(source)?.at(-1)?.exchangeTsMs ?? Number.NEGATIVE_INFINITY),
        );
        if (!Number.isFinite(anchor)) return [];
        return sources
          .flatMap((source) => windowByTimestamp(sourceMap.get(source) ?? [], anchor - lookbackMs, anchor, (item) => item.exchangeTsMs))
          .sort((left, right) => left.exchangeTsMs - right.exchangeTsMs);
      },
      getNearest: (source, tsMs, maxDistanceMs) =>
        nearestByTimestamp(sourceMap.get(source) ?? [], tsMs, maxDistanceMs, (item) => item.exchangeTsMs),
      getNearestBeforeOrAt: (source, tsMs, maxDistanceMs) =>
        nearestBeforeOrAtByTimestamp(sourceMap.get(source) ?? [], tsMs, maxDistanceMs, (item) => item.exchangeTsMs),
    };
  }

  /**
   * Последний ценовой тик источника (с timestamp) — для проверки свежести (#4).
   *
   * @param symbolOrAsset - Символ или базовый актив
   * @param source - Источник цены
   * @returns Точка `{ price, exchangeTsMs, receivedTsMs }` или `undefined`
   */
  getLatestPricePoint(symbolOrAsset: string, source: CryptoPriceSource): CryptoPricePoint | undefined {
    const asset = normalizeAsset(inferAssetFromSymbol(symbolOrAsset));
    return this._prices.get(asset)?.get(source)?.at(-1);
  }

  /**
   * Ценовой тик источника, ближайший к `tsMs` в пределах `maxDistanceMs` (#4).
   *
   * @remarks
   * Для settlement нужна цена около expiry, а не просто самая свежая на момент
   * вызова — поэтому ищем ближайшую к `settlementTsMs`, а не последнюю.
   */
  getNearestPricePoint(
    symbolOrAsset: string,
    source: CryptoPriceSource,
    tsMs: number,
    maxDistanceMs: number,
  ): CryptoPricePoint | undefined {
    const asset = normalizeAsset(inferAssetFromSymbol(symbolOrAsset));
    return nearestByTimestamp(this._prices.get(asset)?.get(source) ?? [], tsMs, maxDistanceMs, (item) => item.exchangeTsMs);
  }

  /**
   * Последняя цена источника для актива (удобный аксессор).
   *
   * @param symbolOrAsset - Символ или базовый актив
   * @param source - Источник цены
   * @returns Цена последнего тика или `undefined`
   *
   * @remarks
   * Эквивалент `getPriceHistory(asset)?.getLatest(source)?.price`. Единый
   * источник истины для цены — используется resolution-слоем и сборкой
   * `snapshot.cryptoPrice` (после отказа от CryptoPriceStore).
   */
  getLatestPrice(symbolOrAsset: string, source: CryptoPriceSource): number | undefined {
    const asset = normalizeAsset(inferAssetFromSymbol(symbolOrAsset));
    return this._prices.get(asset)?.get(source)?.at(-1)?.price;
  }

  getVenueState(symbolOrAsset: string): CryptoVenueStateView | undefined {
    const asset = normalizeAsset(inferAssetFromSymbol(symbolOrAsset));
    const stateMap = this._venueStates.get(asset);
    if (!stateMap) return undefined;

    return {
      asset,
      get: (venue) => stateMap.get(venue),
      getAll: () => [...stateMap.values()],
    };
  }

  getVenueHistory(symbolOrAsset: string): CryptoVenueHistoryView | undefined {
    const asset = normalizeAsset(inferAssetFromSymbol(symbolOrAsset));
    const bookMap = this._books.get(asset);
    const tradeMap = this._trades.get(asset);
    if (!bookMap && !tradeMap) return undefined;

    return {
      asset,
      getRecentBooks: (venue, lookbackMs, nowMs) => {
        const history = bookMap?.get(venue) ?? [];
        const anchor = nowMs ?? history.at(-1)?.exchangeTsMs;
        if (anchor === undefined) return [];
        return windowByTimestamp(history, anchor - lookbackMs, anchor, (item) => item.exchangeTsMs);
      },
      getRecentTrades: (venue, lookbackMs, nowMs) => {
        const history = tradeMap?.get(venue) ?? [];
        const anchor = nowMs ?? history.at(-1)?.exchangeTsMs;
        if (anchor === undefined) return [];
        return windowByTimestamp(history, anchor - lookbackMs, anchor, (item) => item.exchangeTsMs);
      },
    };
  }

  private _recordVenuePrice(
    asset: string,
    venue: CexVenue,
    price: number,
    exchangeTsMs: number,
    receivedTsMs: number,
  ): void {
    const source = cexVenueToPriceSource(venue);
    const sourceMap = getOrCreateNestedMap(this._prices, asset);
    const history = getOrCreateArray(sourceMap, source);
    insertSortedUniqueByTimestamp(history, { asset, source, price, exchangeTsMs, receivedTsMs }, (item) => item.exchangeTsMs);
    const latestTs = history.at(-1)?.exchangeTsMs ?? exchangeTsMs;
    pruneAndCap(history, latestTs - this._priceRetentionMs, this._maxHistoryCount, (item) => item.exchangeTsMs);
  }

  private _computeRecentTradePressure(asset: string, venue: CexVenue, nowMs: number): number {
    const trades = this._trades.get(asset)?.get(venue) ?? [];
    if (trades.length === 0) return 0;

    let signedNotional = 0;
    let notional = 0;
    const minTs = nowMs - this._tradePressureLookbackMs;

    for (let index = trades.length - 1; index >= 0; index--) {
      const trade = trades[index]!;
      // Look-ahead guard (#6): при out-of-order replay в массиве могут лежать
      // трейды «из будущего» относительно nowMs — пропускаем их.
      if (trade.exchangeTsMs > nowMs) continue;
      if (trade.exchangeTsMs < minTs) break;
      const value = trade.price * trade.size;
      notional += value;
      signedNotional += trade.side === 'sell' ? -value : trade.side === 'buy' ? value : 0;
    }

    return notional > 0 ? signedNotional / notional : 0;
  }

  /**
   * Проверяет правдоподобность `exchangeTsMs` перед записью тика (#14).
   *
   * Алгоритм:
   * 1. `exchangeTsMs` должен быть конечным числом.
   * 2. Должен быть не меньше {@link MIN_PLAUSIBLE_EPOCH_MS} (отсекает timestamp
   *    в секундах и мусор, который иначе вставился бы как «очень старый»).
   * 3. Не должен опережать `receivedTsMs` больше чем на `maxFutureSkewMs`
   *    (защита prune от вычистки истории битым «будущим» timestamp).
   *
   * @param exchangeTsMs - Timestamp биржи (epoch ms)
   * @param receivedTsMs - Локальное время получения (epoch ms)
   * @param kind - Тип тика для лога (`price` | `book` | `trade`)
   * @param symbol - Символ для лога
   * @returns `true` если тик принят, `false` если отбракован
   */
  private _acceptTimestamp(
    exchangeTsMs: number,
    receivedTsMs: number,
    kind: 'price' | 'book' | 'trade',
    symbol: string,
  ): boolean {
    if (
      Number.isFinite(exchangeTsMs)
      && exchangeTsMs >= MIN_PLAUSIBLE_EPOCH_MS
      && exchangeTsMs <= receivedTsMs + this._maxFutureSkewMs
    ) {
      return true;
    }

    this._rejectedTickCount++;
    this._logger?.warn('Rejected tick with implausible timestamp', {
      kind,
      symbol,
      exchangeTsMs,
      receivedTsMs,
      maxFutureSkewMs: this._maxFutureSkewMs,
    });
    return false;
  }

  /**
   * Уведомляет о материальном движении CEX microprice — per (asset, venue) (#7).
   *
   * Алгоритм:
   * 1. Сырой режим (`notifyCexChanges=true`) — уведомляем всегда (обработано в caller).
   * 2. Слой выключен (`materialMoveBps <= 0`) — молчим.
   * 3. Первое наблюдение по (asset,venue) — фиксируем точку отсчёта, не будим.
   * 4. Иначе будим, только если сдвиг ≥ `materialMoveBps` И прошло
   *    ≥ `materialMoveMinIntervalMs` с прошлого уведомления по этой бирже.
   *
   * @remarks
   * Точка отсчёта хранится per venue: движение Binance сравнивается с прошлым
   * Binance, а не с чужой биржей (иначе reference смешивался бы между venue).
   */
  private _maybeNotifyCexMove(asset: string, venue: CexVenue, microprice: number, nowMs: number): void {
    if (this._materialMoveBps <= 0 || microprice <= 0) return;

    const byVenue = getOrCreateNestedMap(this._lastCexNotify, asset);
    const last = byVenue.get(venue);
    if (last === undefined) {
      byVenue.set(venue, { tsMs: nowMs, refMicroprice: microprice });
      return;
    }

    const moveBps = Math.abs(microprice - last.refMicroprice) / last.refMicroprice * 10_000;
    if (moveBps < this._materialMoveBps) return;
    if (nowMs - last.tsMs < this._materialMoveMinIntervalMs) return;

    byVenue.set(venue, { tsMs: nowMs, refMicroprice: microprice });
    this._onChange?.(asset, 'CRYPTO_MARKET_DATA');
  }

  /**
   * Уведомляет о крупном трейде (#8) — per (asset, venue).
   *
   * @param asset - Базовый актив
   * @param venue - Биржа
   * @param notional - Нотионал трейда (price × size, USD)
   * @param nowMs - Время трейда (exchangeTsMs)
   *
   * @remarks
   * Будит стратегию, если `notional ≥ materialTradeNotional` И прошло
   * ≥ `materialMoveMinIntervalMs` с прошлого trade-notify по этой бирже.
   * Связывает trade-pressure с триггером (раньше будил только book move).
   */
  private _maybeNotifyTrade(asset: string, venue: CexVenue, notional: number, nowMs: number): void {
    if (this._materialTradeNotional <= 0 || notional < this._materialTradeNotional) return;

    const byVenue = getOrCreateNestedMap(this._lastTradeNotify, asset);
    const lastTs = byVenue.get(venue);
    if (lastTs !== undefined && nowMs - lastTs < this._materialMoveMinIntervalMs) return;

    byVenue.set(venue, nowMs);
    this._onChange?.(asset, 'CRYPTO_MARKET_DATA');
  }
}

function getOrCreateNestedMap<K1, K2, V>(store: Map<K1, Map<K2, V>>, key: K1): Map<K2, V> {
  let nested = store.get(key);
  if (!nested) {
    nested = new Map<K2, V>();
    store.set(key, nested);
  }
  return nested;
}

function getOrCreateArray<K, V>(store: Map<K, V[]>, key: K): V[] {
  let values = store.get(key);
  if (!values) {
    values = [];
    store.set(key, values);
  }
  return values;
}

function insertSortedUniqueByTimestamp<T>(
  items: T[],
  item: T,
  getTs: (item: T) => number,
): boolean {
  const ts = getTs(item);
  const oldLength = items.length;
  let index = oldLength;

  while (index > 0 && getTs(items[index - 1]!) > ts) {
    index--;
  }

  if (index > 0 && getTs(items[index - 1]!) === ts) {
    items[index - 1] = item;
    return index === oldLength;
  }

  if (index < oldLength && getTs(items[index]!) === ts) {
    items[index] = item;
    return false;
  }

  items.splice(index, 0, item);
  return index === oldLength;
}

function pruneByTimestamp<T>(items: T[], minTs: number, getTs: (item: T) => number): void {
  let removeCount = 0;
  while (removeCount < items.length && getTs(items[removeCount]!) < minTs) {
    removeCount++;
  }
  if (removeCount > 0) {
    items.splice(0, removeCount);
  }
}

/**
 * Prune по времени + жёсткий count-cap (#M3).
 *
 * @remarks
 * Сначала отсекает элементы старше `minTs`, затем — если массив всё ещё длиннее
 * `maxCount` — удаляет самые старые с начала. Защищает память при
 * высокочастотном потоке (retention по времени недостаточно).
 */
function pruneAndCap<T>(items: T[], minTs: number, maxCount: number, getTs: (item: T) => number): void {
  pruneByTimestamp(items, minTs, getTs);
  if (items.length > maxCount) {
    items.splice(0, items.length - maxCount);
  }
}

// ── Валидация конфига (#U2) ──────────────────────────────────────────────────

/**
 * Возвращает `value`, если это конечное положительное число, иначе `fallback`
 * (с warn). Для retention/lookback/skew, где `<= 0`/NaN/Inf ломают pruning/guard.
 */
function sanitizePositiveMs(value: number | undefined, fallback: number, log?: ILogger, name?: string): number {
  if (value === undefined) return fallback;
  if (Number.isFinite(value) && value > 0) return value;
  log?.warn('Invalid config value, using default', { param: name, value, fallback });
  return fallback;
}

/**
 * Возвращает `value`, если это конечное неотрицательное число (0 допустим — напр.
 * «выключено»/«нет интервала»), иначе `fallback` (с warn).
 */
function sanitizeNonNegative(value: number | undefined, fallback: number, log?: ILogger, name?: string): number {
  if (value === undefined) return fallback;
  if (Number.isFinite(value) && value >= 0) return value;
  log?.warn('Invalid config value, using default', { param: name, value, fallback });
  return fallback;
}

/**
 * Возвращает целое `>= 1` (округление вниз), иначе `fallback` (с warn).
 * Для счётчиков (maxBookLevels, maxHistoryCount), где NaN/0 ломают slice/cap.
 */
function sanitizeCount(value: number | undefined, fallback: number, log?: ILogger, name?: string): number {
  if (value === undefined) return fallback;
  if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  log?.warn('Invalid config value, using default', { param: name, value, fallback });
  return fallback;
}

/**
 * Вставляет элемент в отсортированный по timestamp массив, **сохраняя дубликаты**.
 *
 * @remarks
 * В отличие от {@link insertSortedUniqueByTimestamp}, элементы с одинаковым
 * timestamp НЕ замещаются — это нужно для трейдов, где несколько сделок часто
 * имеют одинаковый `exchangeTsMs` (мс). На mostly-ordered потоке вставка
 * амортизированно O(1) (линейный проход назад только до точки вставки).
 *
 * @param items - Целевой массив (мутируется)
 * @param item - Вставляемый элемент
 * @param getTs - Извлечение timestamp из элемента
 * @returns `true` если элемент вставлен в конец (т.е. он самый свежий)
 */
function insertSortedAllowDuplicates<T>(
  items: T[],
  item: T,
  getTs: (item: T) => number,
): boolean {
  const ts = getTs(item);
  const oldLength = items.length;
  let index = oldLength;

  while (index > 0 && getTs(items[index - 1]!) > ts) {
    index--;
  }

  items.splice(index, 0, item);
  return index === oldLength;
}

/**
 * Возвращает срез элементов с timestamp в окне `[minTs, maxTs]` (обе границы включительно).
 *
 * @remarks
 * Верхняя граница `maxTs` отсекает элементы «из будущего» — защита от look-ahead
 * при out-of-order replay и от привязки к устаревшему последнему тику (#8).
 *
 * @param items - Отсортированный по возрастанию timestamp массив
 * @param minTs - Нижняя граница окна (включительно)
 * @param maxTs - Верхняя граница окна (включительно)
 * @param getTs - Извлечение timestamp из элемента
 * @returns Срез в окне `[minTs, maxTs]`
 */
/**
 * Фильтрует невалидные уровни и сортирует по цене (#8 + #10).
 *
 * @param levels - Уровни (price, size)
 * @param dir - `desc` для bids (лучший = макс. цена), `asc` для asks (лучший = мин. цена)
 * @returns Новый массив без мусорных уровней, отсортированный (вход не мутируется)
 *
 * @remarks
 * - #8: отсекаются уровни с не-конечной/неположительной ценой или size — иначе
 *   microprice/imbalance/sizeSum стали бы мусором даже при валидном best price.
 * - #10: сортировка гарантирует, что `levels[0]` — действительно best bid/ask,
 *   независимо от порядка, присланного upstream.
 */
function normalizeLevels(
  levels: readonly (readonly [number, number])[],
  dir: 'asc' | 'desc',
): (readonly [number, number])[] {
  const clean = levels.filter(
    ([price, size]) =>
      Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0,
  );
  clean.sort((a, b) => (dir === 'desc' ? b[0] - a[0] : a[0] - b[0]));
  return clean;
}

/**
 * Находит элемент, ближайший по timestamp к `targetTs`, в пределах `maxDistanceMs` (#9).
 *
 * @param items - Отсортированный по возрастанию timestamp массив
 * @param targetTs - Целевой момент (epoch ms)
 * @param maxDistanceMs - Макс. допустимое отклонение
 * @param getTs - Извлечение timestamp
 * @returns Ближайший элемент или `undefined`
 */
function nearestByTimestamp<T>(
  items: readonly T[],
  targetTs: number,
  maxDistanceMs: number,
  getTs: (item: T) => number,
): T | undefined {
  if (!(maxDistanceMs >= 0)) return undefined; // guard: отрицательный/NaN допуск
  let best: T | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const distance = Math.abs(getTs(item) - targetTs);
    if (distance <= maxDistanceMs && distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Находит элемент с timestamp ≤ `targetTs`, ближайший к нему снизу, в пределах
 * `maxDistanceMs` (#9). Массив отсортирован по возрастанию.
 */
function nearestBeforeOrAtByTimestamp<T>(
  items: readonly T[],
  targetTs: number,
  maxDistanceMs: number,
  getTs: (item: T) => number,
): T | undefined {
  if (!(maxDistanceMs >= 0)) return undefined; // guard: отрицательный/NaN допуск
  for (let index = items.length - 1; index >= 0; index--) {
    const ts = getTs(items[index]!);
    if (ts <= targetTs) {
      return targetTs - ts <= maxDistanceMs ? items[index] : undefined;
    }
  }
  return undefined;
}

/**
 * Срез элементов с timestamp в `[minTs, maxTs]` через binary search (#M5a).
 *
 * @remarks
 * Массив отсортирован по возрастанию timestamp → находим границы за O(log n)
 * вместо O(n)-скана (важно при 30-мин ретеншене на десятки тысяч элементов,
 * сигналы зовут это per-tick).
 */
function windowByTimestamp<T>(
  items: readonly T[],
  minTs: number,
  maxTs: number,
  getTs: (item: T) => number,
): readonly T[] {
  if (minTs > maxTs) return [];
  // start = первый индекс с ts >= minTs
  const start = lowerBound(items, minTs, getTs);
  // end = первый индекс с ts > maxTs (exclusive)
  const end = upperBound(items, maxTs, getTs);
  return start < end ? items.slice(start, end) : [];
}

/** Первый индекс, где `getTs(items[i]) >= target` (binary search). */
function lowerBound<T>(items: readonly T[], target: number, getTs: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (getTs(items[mid]!) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Первый индекс, где `getTs(items[i]) > target` (binary search). */
function upperBound<T>(items: readonly T[], target: number, getTs: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (getTs(items[mid]!) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function normalizePriceSource(
  source: UpdateCryptoPriceInput['source'] | undefined,
  symbol: string,
): CryptoPriceSource {
  if (source === 'chainlink') return 'polymarket_chainlink';
  if (source === 'binance') return 'polymarket_binance';
  if (source) return source;
  return symbol.includes('/') ? 'polymarket_chainlink' : 'polymarket_binance';
}

function cexVenueToPriceSource(venue: CexVenue): CryptoPriceSource {
  return `cex_${venue}` as CryptoPriceSource;
}

function inferAssetFromSymbol(symbol: string): string {
  const trimmed = symbol.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.includes('/')) return trimmed.split('/')[0] ?? '';
  if (trimmed.includes('-')) return trimmed.split('-')[0] ?? '';
  return trimmed.replace(/usd[tc]?$/i, '');
}

function normalizeAsset(asset: string): string {
  return asset.trim().toLowerCase();
}
