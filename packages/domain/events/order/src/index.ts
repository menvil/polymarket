/**
 * @polymarket/order-events — canonical источник domain-событий Order.
 *
 * @remarks
 * Domain events — факты изменения Order-агрегата, отражают переходы его FSM.
 *
 * Legacy-контракт: `Order` больше их не создаёт и не восстанавливается из них
 * (`pullEvents()`/`fromEvents()` удалены); producer'ов в активном дереве нет,
 * тип живёт в union доставки `EventBusEvent`. См. README пакета.
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
export type { OrderCreatedEvent, OrderCreatedPayload } from './OrderCreatedEvent.js';
export type { OrderAcceptedEvent, OrderAcceptedPayload } from './OrderAcceptedEvent.js';
export type { OrderRejectedEvent, OrderRejectedPayload } from './OrderRejectedEvent.js';
export type { OrderCancelledEvent, OrderCancelledPayload } from './OrderCancelledEvent.js';
export type { OrderExpiredEvent, OrderExpiredPayload } from './OrderExpiredEvent.js';
export type { OrderPartiallyFilledEvent, OrderPartiallyFilledPayload } from './OrderPartiallyFilledEvent.js';
export type { OrderFilledEvent, OrderFilledPayload } from './OrderFilledEvent.js';
export type { OrderEvent } from './OrderEvent.js';
