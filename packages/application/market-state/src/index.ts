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
 * - `TradeIndexCollector` — индекс построенных `Trade` для `ExecutionLinker`
 *   (`@polymarket/use-cases`, Этап 7); реальный путь поиска — `findMatch()`, не
 *   точный `get()` по `VenueTradeId` (см. TSDoc класса)
 * - `MarketDataStore` — фасад/владелец подписок: объединяет коллекторы +
 *   TopOfBook tracking; единая точка доступа к рыночным данным для StrategyScheduler
 * - `CryptoMarketDataStore` — long-lived история цен/CEX-стаканов per asset
 * - `CryptoResolutionStore` — strike/resolution lifecycle крипто-рынков
 *
 * @example
 * ```typescript
 * import { BookDepthCollector, TradeTapeCollector, TradeIndexCollector, MarketDataStore } from '@polymarket/market-state';
 *
 * const bookCollectorResult = BookDepthCollector.create({ logger, clock }, { maxCount: 500 });
 * if (!bookCollectorResult.ok) throw bookCollectorResult.error;
 * const bookCollector = bookCollectorResult.value;
 *
 * const tapeCollectorResult = TradeTapeCollector.create({ catalog, logger, clock }, { maxAgeMs: 300_000 });
 * if (!tapeCollectorResult.ok) throw tapeCollectorResult.error;
 * const tapeCollector = tapeCollectorResult.value;
 *
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
/** Реэкспорт зависимостей/конфига BookDepthCollector (см. BookDepthCollector.ts). */
export type { BookDepthCollectorDeps, BookDepthCollectorConfig } from './BookDepthCollector.js';

export { TradeTapeCollector } from './TradeTapeCollector.js';
/** Реэкспорт зависимостей/конфига TradeTapeCollector (см. TradeTapeCollector.ts). */
export type { TradeTapeCollectorDeps, TradeTapeCollectorConfig } from './TradeTapeCollector.js';

export { TradeIndexCollector } from './TradeIndexCollector.js';
/** Реэкспорт конфига TradeIndexCollector (см. TradeIndexCollector.ts). */
export type { TradeIndexCollectorConfig } from './TradeIndexCollector.js';

export { MarketDataStore } from './MarketDataStore.js';
/** Реэкспорт зависимостей/типов MarketDataStore (см. MarketDataStore.ts). */
export type { MarketDataStoreDeps, MarketDataReason, TopOfBookState } from './MarketDataStore.js';

export { CryptoResolutionStore } from './CryptoResolutionStore.js';
/** Реэкспорт интерфейса чтения последней цены (см. CryptoResolutionStore.ts). */
export type { LatestPriceReader } from './CryptoResolutionStore.js';

export { CryptoMarketDataStore } from './CryptoMarketDataStore.js';
/** Реэкспорт типов конфигурации/данных CryptoMarketDataStore (см. CryptoMarketDataStore.ts). */
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
/** Реэкспорт типов запроса/результата/контекста CryptoSignalRegistry (см. CryptoSignalRegistry.ts). */
export type {
  CryptoSignalCalculator,
  CryptoSignalContext,
  CryptoSignalDirection,
  CryptoSignalRegistryView,
  CryptoSignalRequest,
  CryptoSignalResult,
} from './CryptoSignalRegistry.js';
