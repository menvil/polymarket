/**
 * @polymarket/event-bus — Application-specific delivery façade для ApplicationEvent.
 *
 * @remarks
 * ### Разделение ответственности:
 * - **Event contracts** — `@polymarket/application-events` (типы событий и
 *   union `ApplicationEvent`; этот пакет их НЕ определяет и НЕ реэкспортирует);
 * - **Delivery mechanics** — `@polymarket/message-bus` (generic-движок:
 *   очередь, fan-out, reentrancy, guards);
 * - **Этот пакет** — Application-фасад доставки: `IEventBus`/`EventBus`,
 *   Application error-контракт, logger-интеграция, диагностика.
 *
 * @example
 * ```typescript
 * import type { ApplicationEvent, BookUpdatedEvent } from '@polymarket/application-events';
 * import { EventBus, type IEventBus } from '@polymarket/event-bus';
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
