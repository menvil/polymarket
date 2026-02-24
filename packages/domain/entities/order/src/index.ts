/**
 * Пакет @polymarket/entities/order
 *
 * @remarks
 * Доменная сущность Order с FSM управлением состоянием.
 *
 * ## Основные экспорты:
 *
 * ### Entity
 * - **Order** — главная сущность заявки
 *
 * ### Value Objects
 * - **OrderFill** — инкапсуляция fill state
 * - **OrderStatus** — типы и утилиты для статусов
 *
 * ### Параметры
 * - **OrderParams** — параметры для Order.create()
 * - **CreateOrderParams** — упрощенные параметры для новой заявки
 *
 * ### View Layer
 * - **OrderViewModel** — сериализация в JSON/readable/summary
 * - **OrderDeserializer** — десериализация из JSON
 * - **OrderSummary** — интерфейс summary для UI
 * - **OrderJSON** — интерфейс JSON представления
 *
 * ### Utilities
 * - **calculations** — getNotional, getRemainingSize, getFillPercentage
 * - **predicates** — isFilled, isOpen, isPending, isPartiallyFilled, etc.
 *
 * ### Types
 * - **OrderChange** — discriminated union для FSM transitions
 *
 * @example
 * ```typescript
 * import { Order, OrderViewModel } from '@polymarket/entities/order';
 * import { Price, Quantity } from '@polymarket/value-objects';
 *
 * // Создание заявки
 * const result = Order.create({
 *   id: 'order-123',
 *   marketId: 'market-1',
 *   tokenId: 'token-yes',
 *   side: 'BUY',
 *   price: Price.fromValue(0.65).value!,
 *   size: Quantity.fromValue(100).value!,
 *   status: 'PENDING',
 *   timestamp: new Date()
 * });
 *
 * if (result.ok) {
 *   const order = result.value;
 *
 *   // Переход состояния
 *   const accepted = order.accept();
 *
 *   // Сериализация
 *   const json = OrderViewModel.toJSON(accepted.value!);
 * }
 * ```
 */

// ==================== Entity ====================
export { Order } from './Order';

// ==================== Value Objects ====================
export { OrderFill } from './value-objects/OrderFill';
export type { OrderStatus } from './value-objects/OrderStatus';
export {
  canTransition,
  isTerminal,
  isActive,
  isFailed,
  isSuccessful,
} from './value-objects/OrderStatus';

// Side теперь экспортируется из @polymarket/value-objects
// import { Side } from '@polymarket/value-objects';

// ==================== Параметры ====================
export type { OrderParams, CreateOrderParams } from './params';

// ==================== View Layer ====================
export {
  OrderViewModel,
  OrderDeserializer,
} from './view';
export type {
  OrderSummary,
  OrderJSON,
} from './view';

// ==================== Utilities ====================
export {
  getNotional,
  getRemainingSize,
  getFillPercentage,
  isFilled,
  isOpen,
  isPending,
  isCanceled,
  isRejected,
  isExpired,
  isPartiallyFilled,
  canModify,
} from './utils';
