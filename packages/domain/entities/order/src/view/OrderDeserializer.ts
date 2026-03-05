/**
 * Deserializer для Order
 *
 * @remarks
 * Парсит плоский снэпшот (примитивы) в OrderState (value objects),
 * затем вызывает Order.rehydrate(state) для создания агрегата.
 *
 * Разделение ответственности:
 * - OrderDeserializer: парсинг примитивов + валидация формата
 * - Order.rehydrate(): кросс-валидация состояния + создание агрегата
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
 *
 * @todo
 * OrderDeserializer и OrderViewModel находятся в пакете domain entity для удобства.
 * Когда архитектура устоится, их можно перенести в application layer —
 * сериализация/десериализация не является частью доменной логики.
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import { Price, Quantity, TimestampService } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';
import { asOrderId, asFillId, parseAssetId } from '@polymarket/ids';
import type { FillId } from '@polymarket/ids';
import Decimal from 'decimal.js';
import type { OrderSnapshot, OrderState, OrderStatus } from '../OrderState.js';
import { Order } from '../Order.js';

const VALID_SIDES = new Set<string>(['BUY', 'SELL']);
const VALID_STATUSES = new Set<string>([
  'PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED',
]);

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
   * Алгоритм:
   * 1. Парсит все примитивы в value objects (id, asset, side, status, timestamp, fillIds)
   * 2. Строит OrderState из value objects
   * 3. Вызывает Order.rehydrate(state) для кросс-валидации и создания агрегата
   * 4. Конвертирует OrderError → ValidationError для совместимости с внешним API
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

    try {
      const id = asOrderId(snap.id);
      if (!id) {
        return Err(new ValidationError('Invalid order ID in snapshot', {
          context: { field: 'id', value: snap.id },
        }));
      }

      const asset = parseAssetId(snap.asset);
      if (!asset) {
        return Err(new ValidationError('Invalid asset in snapshot', {
          context: { field: 'asset', orderId: snap.id },
        }));
      }

      if (!VALID_SIDES.has(snap.side)) {
        return Err(new ValidationError(`Invalid side in snapshot: ${snap.side}`, {
          context: { field: 'side', orderId: snap.id },
        }));
      }

      if (!VALID_STATUSES.has(snap.status)) {
        return Err(new ValidationError(`Invalid status in snapshot: ${snap.status}`, {
          context: { field: 'status', orderId: snap.id },
        }));
      }

      const tsResult = TimestampService.fromISO(snap.timestamp);
      if (!tsResult.ok) {
        return Err(new ValidationError(`Invalid timestamp in snapshot: ${tsResult.error.message}`, {
          context: { field: 'timestamp', orderId: snap.id },
        }));
      }

      const fillIds: FillId[] = [];
      for (const rawId of snap.fillIds) {
        const fillId = asFillId(rawId);
        if (!fillId) {
          return Err(new ValidationError(`Invalid fill ID in snapshot: ${rawId}`, {
            context: { field: 'fillIds', orderId: snap.id },
          }));
        }
        fillIds.push(fillId);
      }

      const filledSize = Quantity.of(new Decimal(snap.filledSize));
      const averagePrice = snap.averagePrice !== undefined
        ? Price.of(new Decimal(snap.averagePrice))
        : undefined;

      const state: OrderState = {
        id,
        asset,
        side: snap.side as Side,
        price: Price.of(new Decimal(snap.price)),
        size: Quantity.of(new Decimal(snap.size)),
        status: snap.status as OrderStatus,
        timestamp: tsResult.value,
        strategyId: snap.strategyId,
        reason: snap.reason,
        fill: { filledSize, averagePrice, fillIds },
      };

      const rehydrateResult = Order.rehydrate(state);
      if (!rehydrateResult.ok) {
        return Err(new ValidationError(rehydrateResult.error.message, {
          context: rehydrateResult.error.context,
        }));
      }

      return Ok(rehydrateResult.value);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Err(new ValidationError(`Failed to restore order from snapshot: ${msg}`, {
        context: { orderId: snap?.id },
      }));
    }
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
