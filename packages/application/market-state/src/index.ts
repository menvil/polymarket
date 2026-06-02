/**
 * @polymarket/market-state — аккумуляторы рыночного состояния
 *
 * @remarks
 * Application-layer пакет для накопления рыночных данных из WS-потока.
 * Коллекторы подписываются на события шины, накапливают данные per tokenId
 * и предоставляют доступ стратегиям.
 *
 * ### Принцип: только запись, стратегия считает сама.
 * Коллекторы не вычисляют сигналы. Они хранят данные.
 * Стратегия забирает нужный срез и применяет нужный алгоритм.
 *
 * ### Содержимое пакета:
 * - `BookDepthCollector` — накапливает снапшоты стакана (BOOK_DEPTH events)
 *   в `OrderBookHistory` per tokenId
 * - `TradeTapeCollector` — накапливает ленту трейдов (TRADE_RECEIVED events)
 *   в `TradeTape` per tokenId
 * - `MarketDataStore` — фасад: объединяет оба коллектора + TopOfBook tracking;
 *   используется StrategyScheduler как единая точка доступа к рыночным данным
 *
 * @example
 * ```typescript
 * import { BookDepthCollector, TradeTapeCollector, MarketDataStore } from '@polymarket/market-state';
 *
 * const bookCollector = new BookDepthCollector(deps, { maxCount: 500 });
 * const tapeCollector = new TradeTapeCollector(deps, { maxAgeMs: 300_000 });
 * const store = new MarketDataStore({ eventBus, bookCollector, tapeCollector, logger });
 *
 * store.setOnChange((instrumentId, reason) => scheduler.onStateChanged(instrumentId, reason));
 * store.start();
 * ```
 */

export { BookDepthCollector } from './BookDepthCollector.js';
export type { BookDepthCollectorDeps, BookDepthCollectorConfig } from './BookDepthCollector.js';

export { TradeTapeCollector } from './TradeTapeCollector.js';
export type { TradeTapeCollectorDeps, TradeTapeCollectorConfig } from './TradeTapeCollector.js';

export { MarketDataStore } from './MarketDataStore.js';
export type { MarketDataStoreDeps, MarketDataReason, TopOfBookState } from './MarketDataStore.js';

export { CryptoResolutionStore } from './CryptoResolutionStore.js';
export type { LatestPriceReader } from './CryptoResolutionStore.js';

export { CryptoMarketDataStore } from './CryptoMarketDataStore.js';
export type {
  CexBookTick,
  CexTradeTick,
  CexVenue,
  CexVenueState,
  CryptoMarketDataReason,
  CryptoMarketDataStoreConfig,
  CryptoPriceHistoryView,
  CryptoPricePoint,
  CryptoPriceSource,
  CryptoVenueHistoryView,
  CryptoVenueStateView,
  UpdateCexBookInput,
  UpdateCexTradeInput,
  UpdateCryptoPriceInput,
} from './CryptoMarketDataStore.js';

export {
  CryptoSignalRegistry,
  createDefaultCryptoSignalRegistry,
} from './CryptoSignalRegistry.js';
export type {
  CryptoSignalCalculator,
  CryptoSignalContext,
  CryptoSignalDirection,
  CryptoSignalRegistryView,
  CryptoSignalRequest,
  CryptoSignalResult,
} from './CryptoSignalRegistry.js';
