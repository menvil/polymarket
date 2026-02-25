/**
 * Handlers для Order FSM transitions
 *
 * @remarks
 * Handlers - это функции которые выполняют конкретный переход состояния.
 * Каждый handler соответствует одному типу OrderChange.
 *
 * ### Архитектура:
 * - Handlers чистые функции (pure functions)
 * - Принимают текущий Order и параметры перехода
 * - Возвращают Result<OrderData, Error> с новыми данными
 * - НЕ создают Order объект (это делает OrderFSM.applyChange)
 * - Выполняют валидацию перехода через guards
 *
 * ### OrderData:
 * Handlers возвращают plain object с обновленными полями,
 * а не Order instance. Это позволяет:
 * - Тестировать handlers независимо от Order
 * - Разделить логику переходов и создание объектов
 * - Упростить композицию handlers
 *
 * @example
 * ```typescript
 * import { handleAccepted } from './handlers';
 *
 * const orderData = {
 *   id: 'order-123',
 *   status: 'PENDING' as OrderStatus,
 *   // ... другие поля
 * };
 *
 * const result = handleAccepted(orderData);
 * if (result.ok) {
 *   console.log(result.value.status); // 'OPEN'
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { OrderStatus as OrderStatusConstructors } from '../value-objects/OrderStatus';
import type { OrderStatus } from '../value-objects/OrderStatus';
import { CancelReason, RejectReason, ExpireReason } from '../value-objects';
import { OrderFill } from '../value-objects/OrderFill';
import type { Quantity, Price, Timestamp } from '@polymarket/value-objects';
import type { OrderId, AccountId, VenueId, InstrumentId, AssetId } from '@polymarket/ids';
import { canAccept, canReject, canCancel, canExpire, canApplyFill } from './guards';

/**
 * Данные Order для handlers
 *
 * @remarks
 * Plain object представление Order для handlers.
 * Handlers работают с этой структурой вместо Order instance.
 *
 * Содержит все поля Order entity:
 * - **Идентификаторы**: id, accountId, venueId, instrumentId, asset
 * - **Параметры**: side, price, size
 * - **Состояние**: status, fill, timestamp
 * - **Опциональные**: strategyId, reason
 */
export interface OrderData {
  readonly id: OrderId;
  readonly accountId: AccountId;
  readonly venueId: VenueId;
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
  readonly side: string;
  readonly price: Price;
  readonly size: Quantity;
  readonly status: OrderStatus;
  readonly timestamp: Timestamp;
  readonly fill: OrderFill;
  readonly strategyId?: string;
  readonly reason?: string;
}

/**
 * Обрабатывает принятие заявки биржей
 *
 * @param order - Текущие данные заявки
 * @returns Result<OrderData, Error> с обновленным статусом
 *
 * @remarks
 * Переход: PENDING → OPEN
 *
 * Означает что заявка прошла валидацию биржи и размещена в orderbook.
 * После accept() заявка становится видимой другим участникам.
 *
 * Валидация:
 * - Текущий статус должен быть PENDING
 *
 * @example
 * ```typescript
 * const result = handleAccepted(orderData);
 * if (result.ok) {
 *   console.log(result.value.status); // 'OPEN'
 * }
 * ```
 */
export function handleAccepted(order: OrderData): Result<OrderData, Error> {
  // Валидация: только PENDING может быть accepted
  if (!canAccept(order.status)) {
    return Err(
      new Error(
        `Cannot accept order with status ${order.status.type}. Only PENDING orders can be accepted.`
      )
    );
  }

  // Создать новые данные со статусом OPEN
  return Ok({
    ...order,
    status: OrderStatusConstructors.open(),
  });
}

/**
 * Обрабатывает отклонение заявки биржей
 *
 * @param order - Текущие данные заявки
 * @param reason - Причина отклонения (обязательна)
 * @returns Result<OrderData, Error> с обновленным статусом
 *
 * @remarks
 * Переход: PENDING → REJECTED
 *
 * Причины отклонения:
 * - Недостаточный баланс
 * - Невалидная цена (вне диапазона)
 * - Рынок закрыт
 * - Нарушение risk limits
 *
 * Валидация:
 * - Текущий статус должен быть PENDING
 * - reason не должен быть пустой строкой
 *
 * @example
 * ```typescript
 * const result = handleRejected(orderData, 'Insufficient balance');
 * if (result.ok) {
 *   console.log(result.value.status); // 'REJECTED'
 *   console.log(result.value.reason); // 'Insufficient balance'
 * }
 * ```
 */
export function handleRejected(order: OrderData, reason: RejectReason): Result<OrderData, Error> {
  // Валидация: только PENDING может быть rejected
  if (!canReject(order.status)) {
    return Err(
      new Error(
        `Cannot reject order with status ${order.status.type}. Only PENDING orders can be rejected.`
      )
    );
  }

  // Создать новые данные со статусом REJECTED
  return Ok({
    ...order,
    status: OrderStatusConstructors.rejected(reason),
  });
}

/**
 * Обрабатывает отмену заявки пользователем
 *
 * @param order - Текущие данные заявки
 * @param reason - Причина отмены (опционально)
 * @returns Result<OrderData, Error> с обновленным статусом
 *
 * @remarks
 * Переход: OPEN или PARTIALLY_FILLED → CANCELED
 *
 * Пользователь может отменить заявку если она еще не полностью исполнена.
 * Частично исполненная заявка сохраняет свой fill.
 *
 * Валидация:
 * - Текущий статус должен быть OPEN или PARTIALLY_FILLED
 *
 * @example
 * ```typescript
 * const result = handleCancelled(orderData, 'Changed strategy');
 * if (result.ok) {
 *   console.log(result.value.status); // 'CANCELED'
 *   console.log(result.value.reason); // 'Changed strategy'
 * }
 * ```
 */
export function handleCancelled(order: OrderData, reason: CancelReason): Result<OrderData, Error> {
  // Валидация: только OPEN или PARTIALLY_FILLED может быть cancelled
  if (!canCancel(order.status)) {
    return Err(
      new Error(
        `Cannot cancel order with status ${order.status.type}. Only OPEN or PARTIALLY_FILLED orders can be cancelled.`
      )
    );
  }

  // Создать новые данные со статусом CANCELED
  return Ok({
    ...order,
    status: OrderStatusConstructors.canceled(reason),
  });
}

/**
 * Обрабатывает истечение заявки по времени
 *
 * @param order - Текущие данные заявки
 * @returns Result<OrderData, Error> с обновленным статусом
 *
 * @remarks
 * Переход: OPEN или PARTIALLY_FILLED → EXPIRED
 *
 * Заявка истекает когда:
 * - Время expiresAt достигнуто
 * - Рынок закрывается
 *
 * Валидация:
 * - Текущий статус должен быть OPEN или PARTIALLY_FILLED
 *
 * @example
 * ```typescript
 * const result = handleExpired(orderData);
 * if (result.ok) {
 *   console.log(result.value.status); // 'EXPIRED'
 *   console.log(result.value.reason); // 'Expired'
 * }
 * ```
 */
export function handleExpired(order: OrderData, reason?: ExpireReason): Result<OrderData, Error> {
  // Валидация: только OPEN или PARTIALLY_FILLED может быть expired
  if (!canExpire(order.status)) {
    return Err(
      new Error(
        `Cannot expire order with status ${order.status.type}. Only OPEN or PARTIALLY_FILLED orders can expire.`
      )
    );
  }

  // Создать новые данные со статусом EXPIRED
  return Ok({
    ...order,
    status: OrderStatusConstructors.expired(reason),
  });
}

/**
 * Данные Fill для применения к заявке
 *
 * @remarks
 * orderId всегда обязателен — Fill без orderId не существует.
 * Это отличает Fill от старой концепции Trade (где orderId был опциональным).
 */
export interface FillData {
  readonly id: string;
  readonly orderId: string;
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: string;
  readonly size: Quantity;
  readonly price: Price;
}

/**
 * Обрабатывает применение fill исполнения к заявке
 *
 * @param order - Текущие данные заявки
 * @param fill - Данные исполнения
 * @returns Result<OrderData, Error> с обновленным fill и статусом
 *
 * @remarks
 * Переходы:
 * - OPEN → PARTIALLY_FILLED (если остаток > 0)
 * - OPEN или PARTIALLY_FILLED → FILLED (если остаток = 0)
 *
 * Это единственный способ fill заявки.
 *
 * Валидация:
 * 1. Статус OPEN или PARTIALLY_FILLED
 * 2. fill.marketId === order.marketId
 * 3. fill.tokenId === order.tokenId
 * 4. fill.side === order.side
 * 5. fill.orderId === order.id (orderId всегда обязателен в Fill)
 * 6. fill.size <= remainingSize
 * 7. Нет дубликата fill.id
 *
 * Обновление:
 * - fill обновляется через OrderFill.addFill()
 * - status → PARTIALLY_FILLED или FILLED
 *
 * @example
 * ```typescript
 * const fillData = {
 *   id: 'fill-1',
 *   orderId: 'order-123',
 *   marketId: 'market-1',
 *   tokenId: 'token-yes',
 *   side: 'BUY',
 *   size: Quantity(30),
 *   price: Price(0.65)
 * };
 *
 * const result = handleFillApplied(orderData, fillData);
 * if (result.ok) {
 *   console.log(result.value.status); // 'PARTIALLY_FILLED' или 'FILLED'
 *   console.log(result.value.fill.getFilledSize().value); // 30
 * }
 * ```
 */
export function handleFillApplied(
  order: OrderData,
  fill: FillData
): Result<OrderData, Error> {
  // Валидация 1: Статус должен быть OPEN или PARTIALLY_FILLED
  if (!canApplyFill(order.status)) {
    return Err(
      new Error(
        `Cannot apply fill to order with status ${order.status.type}. Only OPEN or PARTIALLY_FILLED orders can accept fills.`
      )
    );
  }

  // Валидация 2: marketId должен совпадать
  if (fill.marketId !== order.marketId) {
    return Err(
      new Error(
        `Fill marketId (${fill.marketId}) does not match order marketId (${order.marketId})`
      )
    );
  }

  // Валидация 3: tokenId должен совпадать
  if (fill.tokenId !== order.tokenId) {
    return Err(
      new Error(
        `Fill tokenId (${fill.tokenId}) does not match order tokenId (${order.tokenId})`
      )
    );
  }

  // Валидация 4: side должна совпадать
  if (fill.side !== order.side) {
    return Err(
      new Error(`Fill side (${fill.side}) does not match order side (${order.side})`)
    );
  }

  // Валидация 5: orderId должен совпадать (Fill.orderId всегда обязателен)
  if (fill.orderId !== order.id) {
    return Err(
      new Error(`Fill orderId (${fill.orderId}) does not match this order id (${order.id})`)
    );
  }

  // Применить fill к OrderFill
  const newFillResult = order.fill.addFill(fill.size, fill.price, fill.id, order.size);

  if (!newFillResult.ok) {
    return Err(new Error(`Failed to apply fill: ${newFillResult.error.message}`));
  }

  const newFill = newFillResult.value;

  // Определить новый статус
  const newStatus: OrderStatus = newFill.isFull(order.size)
    ? OrderStatusConstructors.filled()
    : OrderStatusConstructors.partiallyFilled();

  // Создать новые данные с обновленным fill и статусом
  return Ok({
    ...order,
    status: newStatus,
    fill: newFill,
  });
}
