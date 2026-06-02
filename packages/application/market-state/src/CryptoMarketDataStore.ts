/**
 * Long-lived crypto market data store.
 *
 * @remarks
 * This store is asset-scoped, not market-scoped. BTC history survives rotation
 * between 5-minute Polymarket markets, while per-market strike/resolution data
 * stays in the strategy registration / cryptoPrice snapshot layer.
 */

import type { ILogger } from '@polymarket/logger';

export type CryptoPriceSource =
  | 'polymarket_chainlink'
  | 'polymarket_binance'
  | 'cex_binance'
  | 'cex_coinbase'
  | 'cex_okx'
  | 'cex_cryptocom'
  | 'cex_kraken';

export type CexVenue = 'binance' | 'coinbase' | 'okx' | 'cryptocom' | 'kraken';

export type CryptoMarketDataReason = 'CRYPTO_PRICE' | 'CRYPTO_MARKET_DATA';

export interface CryptoPricePoint {
  readonly asset: string;
  readonly source: CryptoPriceSource;
  readonly price: number;
  readonly exchangeTsMs: number;
  readonly receivedTsMs: number;
}

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

export interface CryptoPriceHistoryView {
  readonly asset: string;
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
}

export interface CryptoVenueStateView {
  readonly asset: string;
  get(venue: CexVenue): CexVenueState | undefined;
  getAll(): readonly CexVenueState[];
}

export interface CryptoVenueHistoryView {
  readonly asset: string;
  /**
   * @param nowMs - Опорное время (epoch ms). См. {@link CryptoPriceHistoryView.getRecent}
   *   — задаёт окно `[nowMs - lookbackMs, nowMs]` с верхней границей.
   */
  getRecentBooks(venue: CexVenue, lookbackMs: number, nowMs?: number): readonly CexBookTick[];
  getRecentTrades(venue: CexVenue, lookbackMs: number, nowMs?: number): readonly CexTradeTick[];
}

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
}

export interface UpdateCryptoPriceInput {
  readonly symbol: string;
  readonly price: number;
  readonly timestampMs: number;
  readonly receivedTsMs?: number;
  readonly asset?: string;
  readonly source?: CryptoPriceSource | 'chainlink' | 'binance';
}

export interface UpdateCexBookInput {
  readonly venue: CexVenue;
  readonly symbol: string;
  readonly exchangeTsMs: number;
  readonly receivedTsMs?: number;
  readonly asset?: string;
  readonly bids: readonly (readonly [number, number])[];
  readonly asks: readonly (readonly [number, number])[];
}

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

export class CryptoMarketDataStore {
  private readonly _priceRetentionMs: number;
  private readonly _bookRetentionMs: number;
  private readonly _tradeRetentionMs: number;
  private readonly _tradePressureLookbackMs: number;
  private readonly _notifyCexChanges: boolean;
  private readonly _materialMoveBps: number;
  private readonly _materialMoveMinIntervalMs: number;
  private readonly _maxFutureSkewMs: number;
  private readonly _maxBookLevels: number;
  private readonly _logger: ILogger | undefined;
  private _rejectedTickCount = 0;
  /** Per-asset точка отсчёта для материального движения (#7). */
  private readonly _lastCexNotify = new Map<string, { tsMs: number; refMicroprice: number }>();

  private readonly _prices = new Map<string, Map<CryptoPriceSource, CryptoPricePoint[]>>();
  private readonly _books = new Map<string, Map<CexVenue, CexBookTick[]>>();
  private readonly _trades = new Map<string, Map<CexVenue, CexTradeTick[]>>();
  private readonly _venueStates = new Map<string, Map<CexVenue, CexVenueState>>();
  private _onChange?: (asset: string, reason: CryptoMarketDataReason) => void;

  constructor(config: CryptoMarketDataStoreConfig = {}) {
    this._priceRetentionMs = config.priceRetentionMs ?? DEFAULT_RETENTION_MS;
    this._bookRetentionMs = config.bookRetentionMs ?? DEFAULT_RETENTION_MS;
    this._tradeRetentionMs = config.tradeRetentionMs ?? DEFAULT_RETENTION_MS;
    this._tradePressureLookbackMs = config.tradePressureLookbackMs ?? DEFAULT_TRADE_PRESSURE_LOOKBACK_MS;
    this._notifyCexChanges = config.notifyCexChanges ?? false;
    this._materialMoveBps = Math.max(0, config.materialMoveBps ?? 0);
    this._materialMoveMinIntervalMs = config.materialMoveMinIntervalMs ?? DEFAULT_MATERIAL_MOVE_MIN_INTERVAL_MS;
    this._maxFutureSkewMs = config.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
    this._maxBookLevels = Math.max(1, config.maxBookLevels ?? DEFAULT_MAX_BOOK_LEVELS);
    this._logger = config.logger?.child({ component: 'CryptoMarketDataStore' });
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
    pruneByTimestamp(history, latestTs - this._priceRetentionMs, (item) => item.exchangeTsMs);

    if (isLatest) {
      this._onChange?.(asset, 'CRYPTO_PRICE');
    }
  }

  updateCexBook(input: UpdateCexBookInput): void {
    if (input.bids.length === 0 || input.asks.length === 0) return;

    const asset = normalizeAsset(input.asset ?? inferAssetFromSymbol(input.symbol));
    if (!asset) return;

    const bid = input.bids[0]?.[0];
    const ask = input.asks[0]?.[0];
    const bidSize = input.bids[0]?.[1] ?? 0;
    const askSize = input.asks[0]?.[1] ?? 0;
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return;

    const receivedTsMs = input.receivedTsMs ?? Date.now();
    if (!this._acceptTimestamp(input.exchangeTsMs, receivedTsMs, 'book', input.symbol)) return;

    const tick: CexBookTick = {
      asset,
      venue: input.venue,
      symbol: input.symbol,
      exchangeTsMs: input.exchangeTsMs,
      receivedTsMs,
      // #4: храним только top-N уровней (память), деривативы ниже считаем по top-of-book.
      bids: input.bids.slice(0, this._maxBookLevels),
      asks: input.asks.slice(0, this._maxBookLevels),
    };

    const bookMap = getOrCreateNestedMap(this._books, asset);
    const bookHistory = getOrCreateArray(bookMap, input.venue);
    const isLatest = insertSortedUniqueByTimestamp(bookHistory, tick, (item) => item.exchangeTsMs);
    const latestTs = bookHistory.at(-1)?.exchangeTsMs ?? tick.exchangeTsMs;
    pruneByTimestamp(bookHistory, latestTs - this._bookRetentionMs, (item) => item.exchangeTsMs);

    const existingState = this._venueStates.get(asset)?.get(input.venue);
    if (existingState && input.exchangeTsMs < existingState.lastBookTsMs) {
      this._recordVenuePrice(asset, input.venue, (bid + ask) / 2, input.exchangeTsMs, receivedTsMs);
      return;
    }

    const mid = (bid + ask) / 2;
    const sizeSum = bidSize + askSize;
    const microprice = sizeSum > 0 ? (ask * bidSize + bid * askSize) / sizeSum : mid;
    const spreadBps = ((ask - bid) / mid) * 10_000;
    const imbalanceTop = sizeSum > 0 ? (bidSize - askSize) / sizeSum : 0;

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
    if (isLatest) {
      this._maybeNotifyCexMove(asset, microprice, input.exchangeTsMs);
    }
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
    pruneByTimestamp(tradeHistory, latestTs - this._tradeRetentionMs, (item) => item.exchangeTsMs);

    const venueState = this._venueStates.get(asset)?.get(input.venue);
    if (venueState && input.exchangeTsMs >= venueState.lastBookTsMs) {
      this._venueStates.get(asset)!.set(input.venue, {
        ...venueState,
        recentTradePressure: this._computeRecentTradePressure(asset, input.venue, input.exchangeTsMs),
      });
    }

    if (isLatest && this._notifyCexChanges) {
      this._onChange?.(asset, 'CRYPTO_MARKET_DATA');
    }
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
    };
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
    pruneByTimestamp(history, latestTs - this._priceRetentionMs, (item) => item.exchangeTsMs);
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
   * Уведомляет о материальном движении CEX microprice (#7).
   *
   * Алгоритм:
   * 1. Сырой режим (`notifyCexChanges=true`) — уведомляем всегда.
   * 2. Слой выключен (`materialMoveBps <= 0`) — молчим.
   * 3. Первое наблюдение по активу — фиксируем точку отсчёта, не будим (нет базы).
   * 4. Иначе будим, только если сдвиг ≥ `materialMoveBps` И прошло
   *    ≥ `materialMoveMinIntervalMs` с прошлого уведомления.
   *
   * @param asset - Базовый актив
   * @param microprice - Текущий microprice биржи
   * @param nowMs - Время апдейта (exchangeTsMs)
   */
  private _maybeNotifyCexMove(asset: string, microprice: number, nowMs: number): void {
    if (this._notifyCexChanges) {
      this._onChange?.(asset, 'CRYPTO_MARKET_DATA');
      return;
    }
    if (this._materialMoveBps <= 0 || microprice <= 0) return;

    const last = this._lastCexNotify.get(asset);
    if (last === undefined) {
      this._lastCexNotify.set(asset, { tsMs: nowMs, refMicroprice: microprice });
      return;
    }

    const moveBps = Math.abs(microprice - last.refMicroprice) / last.refMicroprice * 10_000;
    if (moveBps < this._materialMoveBps) return;
    if (nowMs - last.tsMs < this._materialMoveMinIntervalMs) return;

    this._lastCexNotify.set(asset, { tsMs: nowMs, refMicroprice: microprice });
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
function windowByTimestamp<T>(
  items: readonly T[],
  minTs: number,
  maxTs: number,
  getTs: (item: T) => number,
): readonly T[] {
  let start = 0;
  while (start < items.length && getTs(items[start]!) < minTs) {
    start++;
  }
  let end = items.length;
  while (end > start && getTs(items[end - 1]!) > maxTs) {
    end--;
  }
  return items.slice(start, end);
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
