/**
 * @polymarket/event-bus — Application-specific delivery façade контура EventBusEvent.
 *
 * @remarks
 * ### Разделение ответственности:
 * - **Application event contracts** — `@polymarket/application-events`
 *   (union `ApplicationEvent`; этот пакет их НЕ определяет и НЕ реэкспортирует);
 * - **Domain Order events** — `@polymarket/order-events` (union `OrderEvent`);
 * - **Delivery mechanics** — `@polymarket/message-bus` (generic-движок:
 *   очередь, fan-out, reentrancy, guards);
 * - **Этот пакет** — Application-фасад доставки: `IEventBus`/`EventBus`,
 *   `EventBusEvent = ApplicationEvent | OrderEvent` (union контура доставки,
 *   не ownership-слой), Application error-контракт, logger-интеграция,
 *   диагностика.
 *
 * @example
 * ```typescript
 * import type { ApplicationEvent, BookUpdatedEvent } from '@polymarket/application-events';
 * import type { OrderEvent } from '@polymarket/order-events';
 * import { EventBus, type IEventBus, type EventBusEvent } from '@polymarket/event-bus';
 *
 * const bus: IEventBus = new EventBus(logger);
 *
 * const unsub = bus.subscribe('BOOK_UPDATED', async (event) => {
 *   // event: BookUpdatedEvent — TypeScript знает точный тип
 *   await strategy.onBookUpdated(event.topOfBook);
 * });
 * ```
 */
/** Реэкспорт порта event bus (см. IEventBus.ts). */
export type { IEventBus, EventHandler } from './IEventBus.js';
/** Union контура доставки (см. EventBusEvent.ts) — не ownership-слой. */
export type { EventBusEvent } from './EventBusEvent.js';
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
