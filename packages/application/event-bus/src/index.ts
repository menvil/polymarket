/**
 * @polymarket/event-bus — канонический источник application-level событий.
 *
 * @remarks
 * ### Содержимое пакета:
 * - `ApplicationEvent` — полный union application-level событий
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
/** Реэкспорт доменных fill-событий (см. events/domain-events.ts). */
export type {
  FillReceivedEvent,
  FillFailedEvent,
  DirectFillAppliedEvent,
} from './events/domain-events.js';
/** Реэкспорт типов событий стакана/тейпа (см. events/market-events.ts). */
export type {
  TopOfBook,
  BookUpdatedEvent,
  BookDepthEvent,
  TradeReceivedEvent,
} from './events/market-events.js';
/** Реэкспорт типов сигналов стратегии (см. events/strategy-events.ts). */
export type { SignalDirection, StrategySignalEvent } from './events/strategy-events.js';
/** Реэкспорт типов lifecycle-событий рынка (см. events/market-lifecycle-events.ts). */
export type {
  MarketOpenedEvent,
  MarketClosedEvent,
  MarketCloseReason,
} from './events/market-lifecycle-events.js';
/** Реэкспорт типов venue-обновлений ордера (см. events/order-update-events.ts). */
export type { VenueOrderUpdate, OrderUpdateReceivedEvent } from './events/order-update-events.js';
/** Реэкспорт порта event bus (см. IEventBus.ts). */
export type { IEventBus, EventHandler } from './IEventBus.js';
export { EventBus } from './EventBus.js';
/**
 * Реэкспорт canonical operational-диагностики (см. @polymarket/message-bus).
 *
 * @remarks
 * `EventBus.getStats()` публично возвращает `MessageBusStats` — общий
 * diagnostics-контракт semantic-фасадов над `MessageBus<T>`; реэкспорт избавляет
 * Application-потребителя от знания package-топологии ради одного типа.
 * Только этот тип: сам движок (`MessageBus`, policies, generic-ошибки, lifecycle)
 * из Application-пакета сознательно НЕ реэкспортируется.
 */
export type { MessageBusStats } from '@polymarket/message-bus';
