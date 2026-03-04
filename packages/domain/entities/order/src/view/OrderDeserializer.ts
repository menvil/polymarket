/**
 * Deserializer для Order
 *
 * @remarks
 * Тонкая обёртка вокруг Order.fromSnapshot() для работы с API/БД форматом.
 * Принимает плоский объект с примитивами и возвращает Order.
 *
 * Преобразование примитивов в value objects происходит внутри Order.fromSnapshot().
 *
 * @example
 * ```typescript
 * import { OrderDeserializer } from './OrderDeserializer';
 *
 * const snap = { id: 'order-123', asset: '...', side: 'BUY', price: 0.65, size: 100,
 *   status: 'OPEN', timestamp: '2024-01-01T00:00:00.000Z', filledSize: 0, fillIds: [] };
 * const result = OrderDeserializer.fromSnapshot(snap);
 *
 * if (result.ok) {
 *   const order = result.value;
 *   console.log(order.status); // 'OPEN'
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { OrderSnapshot } from '../OrderState.js';
import { Order } from '../Order.js';

/**
 * Класс OrderDeserializer — десериализация снэпшотов в Order
 */
export class OrderDeserializer {
  /**
   * Приватный конструктор — static-only class
   */
  private constructor() {
    throw new Error('OrderDeserializer is a static class');
  }

  /**
   * Десериализует снэпшот в Order
   *
   * @param snap - OrderSnapshot с примитивными значениями
   * @returns Result<Order, ValidationError>
   *
   * @remarks
   * Делегирует в Order.fromSnapshot().
   * Конвертирует OrderError в ValidationError для совместимости с внешним API.
   *
   * @example
   * ```typescript
   * const result = OrderDeserializer.fromSnapshot({
   *   id: 'order-1', asset: '...', side: 'BUY',
   *   price: 0.65, size: 100, status: 'OPEN',
   *   timestamp: '2024-01-01T00:00:00.000Z',
   *   filledSize: 0, fillIds: [],
   * });
   * ```
   */
  public static fromSnapshot(snap: OrderSnapshot): Result<Order, ValidationError> {
    if (!snap || typeof snap !== 'object') {
      return Err(new ValidationError('Invalid snapshot: must be an object', { context: { snap } }));
    }

    const result = Order.fromSnapshot(snap);
    if (!result.ok) {
      return Err(new ValidationError(result.error.message, {
        context: result.error.context,
      }));
    }

    return Ok(result.value);
  }

  /**
   * Десериализует массив снэпшотов
   *
   * @param snapshots - Массив OrderSnapshot
   * @returns Result<Order[], ValidationError>
   *
   * @remarks
   * Останавливается на первой ошибке.
   *
   * @example
   * ```typescript
   * const result = OrderDeserializer.fromSnapshotArray([snap1, snap2]);
   * if (result.ok) console.log(`Loaded ${result.value.length} orders`);
   * ```
   */
  public static fromSnapshotArray(snapshots: readonly OrderSnapshot[]): Result<Order[], ValidationError> {
    if (!Array.isArray(snapshots)) {
      return Err(new ValidationError('Invalid snapshots: must be an array', { context: { snapshots } }));
    }

    const orders: Order[] = [];
    for (let i = 0; i < snapshots.length; i++) {
      const result = this.fromSnapshot(snapshots[i]);
      if (!result.ok) {
        return Err(new ValidationError(`Failed to deserialize order at index ${i}: ${result.error.message}`, {
          context: { index: i },
        }));
      }
      orders.push(result.value);
    }

    return Ok(orders);
  }

  /**
   * Десериализует массив с пропуском ошибок
   *
   * @param snapshots - Массив OrderSnapshot
   * @returns Успешно загруженные Order
   *
   * @remarks
   * Пропускает невалидные записи.
   *
   * @example
   * ```typescript
   * const orders = OrderDeserializer.fromSnapshotArrayPartial([snap1, invalidSnap, snap2]);
   * console.log(orders.length); // 2
   * ```
   */
  public static fromSnapshotArrayPartial(snapshots: readonly OrderSnapshot[]): Order[] {
    if (!Array.isArray(snapshots)) return [];

    const orders: Order[] = [];
    for (const snap of snapshots) {
      const result = this.fromSnapshot(snap);
      if (result.ok) {
        orders.push(result.value);
      }
    }
    return orders;
  }

  /**
   * @deprecated Используйте fromSnapshot() — принимает OrderSnapshot напрямую
   */
  public static fromJSON(json: OrderSnapshot): Result<Order, ValidationError> {
    return this.fromSnapshot(json);
  }

  /**
   * @deprecated Используйте fromSnapshotArray()
   */
  public static fromJSONArray(jsonArray: readonly OrderSnapshot[]): Result<Order[], ValidationError> {
    return this.fromSnapshotArray(jsonArray);
  }
}
