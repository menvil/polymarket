/**
 * `@polymarket/trading-state` — оперативное состояние торгового рантайма.
 *
 * @remarks
 * Пакет строит hot state ТОЛЬКО из canonical application events, приходящих
 * по `IEventBus`. Источников, вендорских DTO, WebSocket, CCXT, RTDS и SDK
 * здесь нет — и не должно появиться: всё это уже приведено к canonical виду
 * семантическими адаптерами до шины.
 *
 * ```text
 * canonical Market
 *   ↓
 * TRADING_MARKET_ADMITTED
 *   ↓
 * IEventBus → TradingStateProjector → TradingHotState
 *                                      └── MarketRuntimeState
 *                                            ├── market      canonical Market
 *                                            ├── lifecycle   наш торговый цикл
 *                                            └── instruments активные данные
 * ```
 *
 * ### Только принятые рынки
 *
 * ```text
 * MarketUniverse            все технически существующие рынки (десятки тысяч)
 * TradingHotState.markets   только те, которые рантайм принял сам
 * ```
 *
 * Market-data по непринятому рынку намеренно ИГНОРИРУЕТСЯ: `IEventBus` общий,
 * и на нём живут данные, нужные коллектору или другому владельцу. Canonical
 * событие не означает автоматически событие торгового состояния.
 *
 * ### Два жизненных цикла
 *
 * ```text
 * Market.state                     внешнее состояние рынка на площадке
 * MarketRuntimeState.lifecycle     что наш рантайм делает с этим рынком
 * ```
 *
 * ### Что видно снаружи
 *
 * Только проектор, read-only проекции, конфигурация хранения, типы
 * наблюдений, статус/времена жизненного цикла, сравнение структуры рынка и
 * ошибки инвариантов. Конкретные mutable-классы состояния
 * (`TradingHotState`, `MarketRuntimeState`, `MarketInstrumentState`,
 * `SharedMarketDataState`, `SharedInstrumentState`, `ReferencePriceState`)
 * НЕ экспортируются: иначе правило «единственный писатель — проектор»
 * осталось бы комментарием, а любой потребитель мог бы вызвать `applyBook()`
 * или `admitMarket()` без единого приведения типов.
 *
 * Стратегия, features, decisions, intents, risk и execution в этот слой не
 * входят — они строятся НАД готовым состоянием отдельными этапами. Strike,
 * priceToBeat и settlement price здесь тоже отсутствуют: canonical `Market`
 * их не содержит, а временное optional-поле стало бы источником истины, у
 * которого нет источника.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * const projector = TradingStateProjector.create(eventBus, retention, clock);
 * if (isErr(projector)) throw projector.error;
 * projector.value.start();
 *
 * const view: TradingHotStateView = projector.value.state();
 * await eventBus.publish(admittedEvent);       // рынок появляется в состоянии
 * const market = view.getMarket(marketId);
 * market?.lifecycle.status;                    // → 'ADMITTED'
 * market?.instrumentIds();                     // → оба исхода, сразу
 * const book = market?.getInstrument(tokenId)?.books.getLatest();
 * ```
 */
export { TradingStateProjector } from './TradingStateProjector.js';
export {
  BookIdentityMismatchError,
  InstrumentMarketConflictError,
  PriceDomainMismatchError,
  TradingMarketAdmissionStateError,
  TradingMarketAdmissionTimingError,
  TradingMarketAlreadyAdmittedError,
  TradingMarketLifecycleTransitionError,
  TradingMarketStructureConflictError,
  UnknownTradingMarketInstrumentError,
  type TradingMarketTransitionViolation,
} from './errors.js';
export {
  findTradingMarketStructureDifference,
  sameTradingMarketStructure,
  type TradingMarketStructuralField,
  type TradingMarketStructureDifference,
} from './marketStructure.js';
export type {
  TradingMarketLifecycleStatus,
  TradingMarketLifecycleView,
} from './lifecycle.js';
export {
  freezeRetentionConfig,
  retentionPolicyEntries,
  type InstrumentRetentionConfig,
  type TradingStateRetentionConfig,
} from './TradingStateRetentionConfig.js';
export type {
  BookObservation,
  Observation,
  PublicTradeObservation,
  ReferencePriceObservation,
  ReferencePriceSeriesKey,
  TickSizeState,
} from './observations.js';
export type {
  MarketInstrumentStateView,
  MarketRuntimeStateView,
  RollingWindowView,
  SharedInstrumentStateView,
  TradingHotStateView,
} from './views.js';
