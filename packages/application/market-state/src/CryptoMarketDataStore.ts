/**
 * Long-lived crypto market data store.
 *
 * @remarks
 * This store is asset-scoped, not market-scoped. BTC history survives rotation
 * between 5-minute Polymarket markets, while per-market strike/resolution data
 * stays in the strategy registration / cryptoPrice snapshot layer.
 */

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
  readonly bids: readonly (readonly [number, number])[];
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
  getRecent(source: CryptoPriceSource, lookbackMs: number): readonly CryptoPricePoint[];
  getMerged(sources: readonly CryptoPriceSource[], lookbackMs: number): readonly CryptoPricePoint[];
}

export interface CryptoVenueStateView {
  readonly asset: string;
  get(venue: CexVenue): CexVenueState | undefined;
  getAll(): readonly CexVenueState[];
}

export interface CryptoVenueHistoryView {
  readonly asset: string;
  getRecentBooks(venue: CexVenue, lookbackMs: number): readonly CexBookTick[];
  getRecentTrades(venue: CexVenue, lookbackMs: number): readonly CexTradeTick[];
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
   */
  readonly notifyCexChanges?: boolean;
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

export class CryptoMarketDataStore {
  private readonly _priceRetentionMs: number;
  private readonly _bookRetentionMs: number;
  private readonly _tradeRetentionMs: number;
  private readonly _tradePressureLookbackMs: number;
  private readonly _notifyCexChanges: boolean;

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
  }

  setOnChange(cb: (asset: string, reason: CryptoMarketDataReason) => void): void {
    this._onChange = cb;
  }

  updatePrice(input: UpdateCryptoPriceInput): void {
    if (!Number.isFinite(input.price) || input.price <= 0) return;

    const asset = normalizeAsset(input.asset ?? inferAssetFromSymbol(input.symbol));
    if (!asset) return;

    const source = normalizePriceSource(input.source, input.symbol);
    const point: CryptoPricePoint = {
      asset,
      source,
      price: input.price,
      exchangeTsMs: input.timestampMs,
      receivedTsMs: input.receivedTsMs ?? Date.now(),
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
    const tick: CexBookTick = {
      asset,
      venue: input.venue,
      symbol: input.symbol,
      exchangeTsMs: input.exchangeTsMs,
      receivedTsMs,
      bids: input.bids,
      asks: input.asks,
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
    if (isLatest && this._notifyCexChanges) {
      this._onChange?.(asset, 'CRYPTO_MARKET_DATA');
    }
  }

  updateCexTrade(input: UpdateCexTradeInput): void {
    if (!Number.isFinite(input.price) || input.price <= 0 || !Number.isFinite(input.size) || input.size <= 0) {
      return;
    }

    const asset = normalizeAsset(input.asset ?? inferAssetFromSymbol(input.symbol));
    if (!asset) return;

    const tick: CexTradeTick = {
      asset,
      venue: input.venue,
      symbol: input.symbol,
      exchangeTsMs: input.exchangeTsMs,
      receivedTsMs: input.receivedTsMs ?? Date.now(),
      price: input.price,
      size: input.size,
      side: input.side,
    };

    const tradeMap = getOrCreateNestedMap(this._trades, asset);
    const tradeHistory = getOrCreateArray(tradeMap, input.venue);
    const isLatest = insertSortedUniqueByTimestamp(tradeHistory, tick, (item) => item.exchangeTsMs);
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
      getRecent: (source, lookbackMs) => {
        const latestTs = sourceMap.get(source)?.at(-1)?.exchangeTsMs;
        if (latestTs === undefined) return [];
        return getRecentByTimestamp(sourceMap.get(source) ?? [], latestTs - lookbackMs, (item) => item.exchangeTsMs);
      },
      getMerged: (sources, lookbackMs) => {
        const latestTs = Math.max(
          ...sources.map((source) => sourceMap.get(source)?.at(-1)?.exchangeTsMs ?? Number.NEGATIVE_INFINITY),
        );
        if (!Number.isFinite(latestTs)) return [];
        return sources
          .flatMap((source) => getRecentByTimestamp(sourceMap.get(source) ?? [], latestTs - lookbackMs, (item) => item.exchangeTsMs))
          .sort((left, right) => left.exchangeTsMs - right.exchangeTsMs);
      },
    };
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
      getRecentBooks: (venue, lookbackMs) => {
        const history = bookMap?.get(venue) ?? [];
        const latestTs = history.at(-1)?.exchangeTsMs;
        if (latestTs === undefined) return [];
        return getRecentByTimestamp(history, latestTs - lookbackMs, (item) => item.exchangeTsMs);
      },
      getRecentTrades: (venue, lookbackMs) => {
        const history = tradeMap?.get(venue) ?? [];
        const latestTs = history.at(-1)?.exchangeTsMs;
        if (latestTs === undefined) return [];
        return getRecentByTimestamp(history, latestTs - lookbackMs, (item) => item.exchangeTsMs);
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
      if (trade.exchangeTsMs < minTs) break;
      const value = trade.price * trade.size;
      notional += value;
      signedNotional += trade.side === 'sell' ? -value : trade.side === 'buy' ? value : 0;
    }

    return notional > 0 ? signedNotional / notional : 0;
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

function getRecentByTimestamp<T>(items: readonly T[], minTs: number, getTs: (item: T) => number): readonly T[] {
  let start = 0;
  while (start < items.length && getTs(items[start]!) < minTs) {
    start++;
  }
  return items.slice(start);
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
