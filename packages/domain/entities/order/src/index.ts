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
 * - `FillData` переехал в `@polymarket/fill` (общий контракт исполнения)
 * - **CreateOrderParams** — параметры для Order.create()
 * - **OrderStatus** — строковый union статусов
 * - **TERMINAL_STATUSES** — множество терминальных статусов
 * - **FILLABLE_STATUSES** — множество статусов принимающих fills
 *
 * ### Domain Events
 * - Domain-события Order переехали в `@polymarket/order-events` (canonical owner)
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

// ─── Entity ────────────────────────────────────────────────────────────────
export { Order } from './Order.js';

// ─── Types ────────────────────────────────────────────────────────────────
/** Реэкспорт типов состояния Order (см. `OrderState.ts` — только структуры, ноль логики). */
export type {
  OrderStatus,
  OrderState,
  FillState,
  CreateOrderParams,
  OrderSnapshot,
} from './OrderState.js';
export { TERMINAL_STATUSES, FILLABLE_STATUSES } from './OrderState.js';

// ─── View Layer ────────────────────────────────────────────────────────────
export { OrderViewModel, OrderDeserializer } from './view/index.js';
/** Реэкспорт интерфейса summary-представления Order (см. `view/OrderViewModel.ts`). */
export type { OrderSummary } from './view/index.js';
