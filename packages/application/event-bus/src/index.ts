/**
 * @polymarket/event-bus — Единственный источник всех типов событий в системе.
 *
 * @remarks
 * ### Содержимое пакета:
 * - `ApplicationEvent` — полный union всех событий
 * - Все event types (FillReceivedEvent, BookUpdatedEvent, etc.)
 * - `IEventBus` / `EventHandler` — интерфейс event bus
 * - `EventBus` — реализация с typed HandlerMap
 *
 * @example
 * ```typescript
 * import { EventBus, type IEventBus, type ApplicationEvent } from '@polymarket/event-bus';
 *
 * const bus: IEventBus = new EventBus(logger);
 *
 * const unsub = bus.subscribe('BOOK_UPDATED', async (event) => {
 *   // event: BookUpdatedEvent — TypeScript знает точный тип
 *   await strategy.onBookUpdated(event.topOfBook);
 * });
 * ```
 */
export type { ApplicationEvent } from './events/index.js';
export type {
  FillReceivedEvent,
} from './events/domain-events.js';
export type {
  TopOfBook,
  BookUpdatedEvent,
  BookDepthEvent,
  TradeReceivedEvent,
} from './events/market-events.js';
export type { RiskViolationType, RiskLimitBreachedEvent } from './events/risk-events.js';
export type { SignalDirection, StrategySignalEvent } from './events/strategy-events.js';
export type {
  MarketOpenedEvent,
  MarketClosedEvent,
  MarketCloseReason,
} from './events/market-lifecycle-events.js';
export type { IEventBus, EventHandler } from './IEventBus.js';
export { EventBus } from './EventBus.js';
