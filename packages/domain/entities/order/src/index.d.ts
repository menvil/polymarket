/**
 * Пакет @polymarket/order
 *
 * @remarks
 * Самодостаточный агрегат Order — вся бизнес-логика заявки в одном модуле.
 *
 * ## Основные экспорты:
 *
 * ### Entity
 * - **Order** — агрегат заявки (create, rehydrate, fromEvents)
 *
 * ### Types
 * - **OrderState** — внутреннее состояние (value objects)
 * - **OrderSnapshot** — внешний формат (примитивы) для персистентности
 * - **FillData** — данные одного исполнения
 * - **CreateOrderParams** — параметры для Order.create()
 * - **OrderStatus** — строковый union статусов
 * - **TERMINAL_STATUSES** — множество терминальных статусов
 * - **FILLABLE_STATUSES** — множество статусов принимающих fills
 *
 * ### Domain Events
 * - **OrderEvent** — union всех событий (для fromEvents/replay)
 *
 * ### View Layer
 * - **OrderViewModel** — сериализация в JSON/readable/summary
 * - **OrderDeserializer** — десериализация из снэпшота
 * - **OrderSummary** — интерфейс summary для UI
 *
 * @example
 * ```typescript
 * import { Order } from '@polymarket/order';
 * import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
 * import { asOrderId } from '@polymarket/ids';
 * import Decimal from 'decimal.js';
 *
 * // Создание заявки
 * const result = Order.create({
 *   id: asOrderId('order-1')!,
 *   asset: myAsset,
 *   side: 'BUY',
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('100')),
 *   timestamp: Timestamp.now(),
 * });
 *
 * if (result.ok) {
 *   const order = result.value;
 *   const accepted = order.accept();
 * }
 * ```
 */
export { Order } from './Order.js';
export type { OrderStatus, OrderState, FillState, FillData, CreateOrderParams, OrderSnapshot, } from './OrderState.js';
export { TERMINAL_STATUSES, FILLABLE_STATUSES } from './OrderState.js';
export type { OrderEvent, OrderCreatedEvent, OrderAcceptedEvent, OrderRejectedEvent, OrderCancelledEvent, OrderExpiredEvent, OrderPartiallyFilledEvent, OrderFilledEvent, } from './OrderEvents.js';
export { OrderViewModel, OrderDeserializer } from './view/index.js';
export type { OrderSummary } from './view/index.js';
//# sourceMappingURL=index.d.ts.map