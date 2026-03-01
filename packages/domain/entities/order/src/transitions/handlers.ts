/**
 * Handlers для Order FSM transitions
 *
 * @remarks
 * Handlers - это чистые функции которые выполняют конкретный переход состояния.
 * Каждый handler соответствует одному типу OrderChange.
 *
 * ### Архитектура:
 * - Handlers чистые функции (pure functions)
 * - Принимают текущий OrderData и параметры перехода
 * - Возвращают Result<OrderData, Error> с новыми данными
 * - НЕ создают Order объект (это делает OrderFSM.apply)
 * - Выполняют валидацию перехода через guards
 *
 * @example
 * ```typescript
 * import { handleAccepted } from './handlers';
 *
 * const result = handleAccepted(orderData);
 * if (result.ok) {
 *   console.log(result.value.status); // 'OPEN'
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import type { OrderStatus } from '../value-objects/OrderStatus';
import { OrderFill } from '../value-objects/OrderFill';
import type { Quantity, Price, Side, Timestamp } from '@polymarket/value-objects';
import type { AssetId, OrderId } from '@polymarket/ids';
import { AssetIdHelpers } from '@polymarket/ids';
import { canAccept, canReject, canCancel, canExpire, canApplyFill } from './guards';
import type { FillForOrder } from '../types/OrderChange';

/**
 * Данные Order для FSM handlers
 *
 * @remarks
 * Plain object (DTO) представление Order для handlers.
 * Handlers работают с этой структурой вместо Order instance,
 * чтобы избежать циклических зависимостей и упростить spread-обновления.
 *
 * Handlers изменяют только `status`, `fill` и `reason` —
 * остальные поля (id, asset, price, size, timestamp) остаются неизменными.
 */
export interface OrderData {
  readonly id: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
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
 * @example
 * ```typescript
 * const result = handleAccepted(orderData);
 * if (result.ok) {
 *   console.log(result.value.status); // 'OPEN'
 * }
 * ```
 */
export function handleAccepted(order: OrderData): Result<OrderData, Error> {
  if (!canAccept(order.status)) {
    return Err(
      new Error(
        `Cannot accept order with status ${order.status}. Only PENDING orders can be accepted.`
      )
    );
  }

  return Ok({ ...order, status: 'OPEN' as OrderStatus });
}

/**
 * Обрабатывает отклонение заявки биржей
 *
 * @param order - Текущие данные заявки
 * @param reason - Причина отклонения
 * @returns Result<OrderData, Error> с обновленным статусом
 *
 * @remarks
 * Переход: PENDING → REJECTED
 *
 * @example
 * ```typescript
 * const result = handleRejected(orderData, 'Insufficient funds');
 * if (result.ok) {
 *   console.log(result.value.status); // 'REJECTED'
 *   console.log(result.value.reason); // 'Insufficient funds'
 * }
 * ```
 */
export function handleRejected(order: OrderData, reason: string): Result<OrderData, Error> {
  if (!canReject(order.status)) {
    return Err(
      new Error(
        `Cannot reject order with status ${order.status}. Only PENDING orders can be rejected.`
      )
    );
  }

  return Ok({ ...order, status: 'REJECTED' as OrderStatus, reason });
}

/**
 * Обрабатывает отмену заявки пользователем
 *
 * @param order - Текущие данные заявки
 * @param reason - Причина отмены
 * @returns Result<OrderData, Error> с обновленным статусом
 *
 * @remarks
 * Переход: OPEN или PARTIALLY_FILLED → CANCELED
 *
 * @example
 * ```typescript
 * const result = handleCancelled(orderData, 'User request');
 * if (result.ok) {
 *   console.log(result.value.status); // 'CANCELED'
 * }
 * ```
 */
export function handleCancelled(order: OrderData, reason: string): Result<OrderData, Error> {
  if (!canCancel(order.status)) {
    return Err(
      new Error(
        `Cannot cancel order with status ${order.status}. Only OPEN or PARTIALLY_FILLED orders can be cancelled.`
      )
    );
  }

  return Ok({ ...order, status: 'CANCELED' as OrderStatus, reason });
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
 * @example
 * ```typescript
 * const result = handleExpired(orderData);
 * if (result.ok) {
 *   console.log(result.value.status); // 'EXPIRED'
 * }
 * ```
 */
export function handleExpired(order: OrderData): Result<OrderData, Error> {
  if (!canExpire(order.status)) {
    return Err(
      new Error(
        `Cannot expire order with status ${order.status}. Only OPEN or PARTIALLY_FILLED orders can expire.`
      )
    );
  }

  return Ok({ ...order, status: 'EXPIRED' as OrderStatus });
}

/**
 * Обрабатывает применение fill исполнения к заявке
 *
 * @param order - Текущие данные заявки
 * @param fill - Данные исполнения (FillForOrder)
 * @returns Result<OrderData, Error> с обновленным fill и статусом
 *
 * @remarks
 * Переходы:
 * - OPEN → PARTIALLY_FILLED (если остаток > 0)
 * - OPEN или PARTIALLY_FILLED → FILLED (если остаток = 0)
 *
 * @example
 * ```typescript
 * const result = handleFillApplied(orderData, fill);
 * if (result.ok) {
 *   console.log(result.value.status); // 'PARTIALLY_FILLED' или 'FILLED'
 * }
 * ```
 */
export function handleFillApplied(
  order: OrderData,
  fill: FillForOrder
): Result<OrderData, Error> {
  // Валидация 1: Статус должен быть OPEN или PARTIALLY_FILLED
  if (!canApplyFill(order.status)) {
    return Err(
      new Error(
        `Cannot apply fill to order with status ${order.status}. Only OPEN or PARTIALLY_FILLED orders can accept fills.`
      )
    );
  }

  // Валидация 2: asset должен совпадать (заменяет отдельные marketId + tokenId проверки)
  if (!AssetIdHelpers.equals(fill.asset, order.asset)) {
    return Err(
      new Error(`Fill asset does not match order asset`)
    );
  }

  // Валидация 3: side должна совпадать
  if (fill.side !== order.side) {
    return Err(new Error(`Fill side (${fill.side}) does not match order side (${order.side})`));
  }

  // Валидация 4: orderId должен совпадать
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
  const newStatus: OrderStatus = newFill.isFull(order.size) ? 'FILLED' : 'PARTIALLY_FILLED';

  return Ok({ ...order, status: newStatus, fill: newFill });
}
