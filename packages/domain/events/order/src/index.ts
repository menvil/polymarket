/**
 * @polymarket/order-events — canonical источник domain-событий Order.
 *
 * @remarks
 * Domain events — факты изменения Order-агрегата: создаются самим агрегатом
 * (`@polymarket/order`), отражают переходы его FSM и используются для
 * replay/history (`Order.fromEvents()`/`Order.pullEvents()`).
 *
 * События — факты, которые уже произошли. Отличие от команд
 * (`accept()`, `applyFill()`):
 * - Команда — намерение (нуждается в валидации, может вернуть ошибку)
 * - Событие — факт (применяется без валидации)
 *
 * Пакет — нижнеуровневый domain-контракт: не зависит ни от Order-entity, ни от
 * application-слоя. `FillData` — общий lightweight-контракт из `@polymarket/fill`
 * (граф: fill ← order-events, fill ← order — без циклов).
 *
 * Application-события живут отдельно — в `@polymarket/application-events`;
 * union контура доставки (`EventBusEvent = ApplicationEvent | OrderEvent`) —
 * в `@polymarket/event-bus`.
 */
export type { OrderCreatedEvent } from './OrderCreatedEvent.js';
export type { OrderAcceptedEvent } from './OrderAcceptedEvent.js';
export type { OrderRejectedEvent } from './OrderRejectedEvent.js';
export type { OrderCancelledEvent } from './OrderCancelledEvent.js';
export type { OrderExpiredEvent } from './OrderExpiredEvent.js';
export type { OrderPartiallyFilledEvent } from './OrderPartiallyFilledEvent.js';
export type { OrderFilledEvent } from './OrderFilledEvent.js';
export type { OrderEvent } from './OrderEvent.js';
