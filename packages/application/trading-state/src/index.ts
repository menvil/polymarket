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
 * Стратегия, features, decisions, intents, risk и execution в этот слой не
 * входят — они строятся НАД готовым состоянием отдельными этапами.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * const state = TradingHotState.create(retention, clock);
 * if (isErr(state)) throw state.error;
 *
 * const projector = new TradingStateProjector(eventBus, state.value);
 * projector.start();
 *
 * const view: TradingHotStateView = projector.state();
 * const book = view.getMarket(marketId)?.getInstrument(tokenId)?.books.getLatest();
 * ```
 */
export { TradingStateProjector } from './TradingStateProjector.js';
export {
  TradingHotState,
  MarketRuntimeState,
  SharedMarketDataState,
  type ObservationTarget,
} from './TradingHotState.js';
export { MarketInstrumentState, SharedInstrumentState } from './instrumentState.js';
export { ReferencePriceState } from './referencePriceState.js';
export { InstrumentMarketConflictError } from './errors.js';
export {
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
  SharedInstrumentKey,
  TickSizeState,
  TopOfBookObservation,
} from './observations.js';
export type {
  MarketInstrumentStateView,
  MarketRuntimeStateView,
  RollingWindowView,
  SharedInstrumentStateView,
  TradingHotStateView,
} from './views.js';
