/**
 * Order Finite State Machine (FSM)
 *
 * @remarks
 * OrderFSM — чистый автомат переходов состояния Order.
 * Принимает текущий статус и change-событие, возвращает `Result<void, Error>`:
 * - `Ok(undefined)` — переход разрешён
 * - `Err(error)` — переход запрещён (нарушен guard)
 *
 * ### Ответственность FSM:
 * Только валидация допустимости перехода через guards.
 * Вся логика обновления состояния (вычисление нового fill, status и т.д.)
 * остаётся внутри Order.
 *
 * ### Что НЕ делает FSM:
 * - Не создаёт OrderData/DTO
 * - Не вычисляет новый OrderFill
 * - Не конструирует новый Order instance
 *
 * @example
 * ```typescript
 * // Внутри Order._transition():
 * const guard = OrderFSM.transition(this.status, change);
 * if (!guard.ok) {
 *   return Err(new ValidationError(guard.error.message, { ... }));
 * }
 * // применить change самостоятельно
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import type { OrderStatus } from '../value-objects/OrderStatus.js';
import type { OrderChange } from '../types/OrderChange.js';
import { canAccept, canReject, canCancel, canExpire, canApplyFill } from './guards.js';

/**
 * Класс OrderFSM — чистый валидатор переходов состояния
 *
 * @remarks
 * Static-only class. Все методы статические.
 * Не создавайте экземпляры этого класса.
 */
export class OrderFSM {
  /**
   * Приватный конструктор — запрещает создание экземпляров
   */
  private constructor() {
    throw new Error('OrderFSM is a static class. Do not instantiate.');
  }

  /**
   * Проверяет допустимость перехода состояния
   *
   * @param status - Текущий статус заявки
   * @param change - Объект OrderChange описывающий изменение
   * @returns `Ok(undefined)` если переход допустим, `Err` — если нет
   *
   * @remarks
   * FSM проверяет только guard-условие: можно ли из данного статуса
   * выполнить данный тип изменения.
   *
   * Логика применения изменения (новый fill, новый статус, reason)
   * остаётся в Order.
   *
   * TypeScript exhaustiveness check гарантирует, что все типы
   * OrderChange обработаны.
   *
   * @example
   * ```typescript
   * const guard = OrderFSM.transition('PENDING', { type: 'ACCEPTED' });
   * guard.ok // true
   *
   * const guard2 = OrderFSM.transition('FILLED', { type: 'ACCEPTED' });
   * guard2.ok // false
   * ```
   */
  public static transition(status: OrderStatus, change: OrderChange): Result<void, Error> {
    switch (change.type) {
      case 'ACCEPTED':
        if (!canAccept(status)) {
          return Err(new Error(
            `Cannot accept order with status ${status}. Only PENDING orders can be accepted.`
          ));
        }
        return Ok(undefined);

      case 'REJECTED':
        if (!canReject(status)) {
          return Err(new Error(
            `Cannot reject order with status ${status}. Only PENDING orders can be rejected.`
          ));
        }
        return Ok(undefined);

      case 'CANCELLED':
        if (!canCancel(status)) {
          return Err(new Error(
            `Cannot cancel order with status ${status}. Only OPEN or PARTIALLY_FILLED orders can be cancelled.`
          ));
        }
        return Ok(undefined);

      case 'EXPIRED':
        if (!canExpire(status)) {
          return Err(new Error(
            `Cannot expire order with status ${status}. Only OPEN or PARTIALLY_FILLED orders can expire.`
          ));
        }
        return Ok(undefined);

      case 'FILL_APPLIED':
        if (!canApplyFill(status)) {
          return Err(new Error(
            `Cannot apply fill to order with status ${status}. Only OPEN or PARTIALLY_FILLED orders can accept fills.`
          ));
        }
        return Ok(undefined);

      default: {
        // TypeScript exhaustiveness check
        const _exhaustive: never = change;
        return Err(new Error(`Unhandled OrderChange type: ${(_exhaustive as any).type}`));
      }
    }
  }
}
