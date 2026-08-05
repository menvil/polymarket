/**
 * @polymarket/market-state — аккумуляторы рыночного состояния
 *
 * @remarks
 * Application-layer пакет для накопления рыночных данных из WS-потока.
 *
 * ### Владение подписками
 * Подписками на EventBus владеет **только** `MarketDataStore`. Коллекторы
 * (`BookDepthCollector`, `TradeTapeCollector`) — **пассивные буферы**: запись
 * через `recordDirect()`, очистка через `clearMarket()`, у них нет `start()/stop()`.
 * Это исключает двойную запись на уровне типов.
 *
 * ### Принцип: только запись, стратегия считает сама.
 * Коллекторы не вычисляют сигналы. Они хранят данные.
 * Стратегия забирает нужный срез и применяет нужный алгоритм.
 *
 * ### Содержимое пакета:
 * - `BookDepthCollector` — буфер снапшотов стакана в `OrderBookHistory` per tokenId
 * - `TradeTapeCollector` — буфер ленты трейдов в `TradeTape` per tokenId
 * - `TradeIndexCollector` — индекс построенных `Trade` по `VenueTradeId` (для будущего
 *   `ExecutionLinker`, Этап 7)
 * - `MarketDataStore` — фасад/владелец подписок: объединяет коллекторы +
 *   TopOfBook tracking; единая точка доступа к рыночным данным для StrategyScheduler
 * - `CryptoMarketDataStore` — long-lived история цен/CEX-стаканов per asset
 * - `CryptoResolutionStore` — strike/resolution lifecycle крипто-рынков
 *
 * @example
 * ```typescript
 * import { BookDepthCollector, TradeTapeCollector, TradeIndexCollector, MarketDataStore } from '@polymarket/market-state';
 *
 * const bookCollector = new BookDepthCollector({ logger, clock }, { maxCount: 500 });
 * const tapeCollector = new TradeTapeCollector({ catalog, logger, clock }, { maxAgeMs: 300_000 });
 * const tradeIndexResult = TradeIndexCollector.create({ maxAgeMs: 300_000 }, clock);
 * if (!tradeIndexResult.ok) throw tradeIndexResult.error;
 * const store = new MarketDataStore({
 *   eventBus, bookCollector, tapeCollector, tradeIndex: tradeIndexResult.value, logger,
 * });
 *
 * store.setOnChange((instrumentId, reason) => scheduler.onStateChanged(instrumentId, reason));
 * store.start(); // только store владеет подписками
 * ```
 */

export { BookDepthCollector } from './BookDepthCollector.js';
export type { BookDepthCollectorDeps, BookDepthCollectorConfig } from './BookDepthCollector.js';

export { TradeTapeCollector } from './TradeTapeCollector.js';
export type { TradeTapeCollectorDeps, TradeTapeCollectorConfig } from './TradeTapeCollector.js';

export { TradeIndexCollector } from './TradeIndexCollector.js';
export type { TradeIndexCollectorConfig } from './TradeIndexCollector.js';

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
