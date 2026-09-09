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
 * canonical Application Events → IEventBus → TradingStateProjector → TradingHotState
 * ```
 *
 * ### Что видно снаружи
 *
 * Только проектор, read-only проекции, конфигурация хранения, типы
 * наблюдений и ошибки инвариантов. Конкретные mutable-классы состояния
 * (`TradingHotState`, `MarketRuntimeState`, `MarketInstrumentState`,
 * `SharedMarketDataState`, `SharedInstrumentState`, `ReferencePriceState`)
 * НЕ экспортируются: иначе правило «единственный писатель — проектор»
 * осталось бы комментарием, а любой потребитель мог бы вызвать `applyBook()`
 * без единого приведения типов.
 *
 * Стратегия, features, decisions, intents, risk и execution в этот слой не
 * входят — они строятся НАД готовым состоянием отдельными этапами.
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
 * const book = view.getMarket(marketId)?.getInstrument(tokenId)?.books.getLatest();
 * ```
 */
export { TradingStateProjector } from './TradingStateProjector.js';
export {
  BookIdentityMismatchError,
  InstrumentMarketConflictError,
  PriceDomainMismatchError,
} from './errors.js';
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
