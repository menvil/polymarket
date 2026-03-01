/**
 * Deserializer для Order
 *
 * @remarks
 * Отвечает за десериализацию JSON в Order объекты.
 * Используется при загрузке данных из API, БД или кэша.
 *
 * Преобразует plain objects в:
 * - Price value objects
 * - Quantity value objects
 * - OrderFill value objects
 * - Date объекты
 *
 * Возвращает Result для безопасной обработки ошибок.
 *
 * @example
 * ```typescript
 * import { OrderDeserializer } from './OrderDeserializer';
 *
 * const json = { id: 'order-123', marketId: 'market-1', ... };
 * const result = OrderDeserializer.fromJSON(json);
 *
 * if (result.ok) {
 *   const order = result.value;
 *   console.log(order.id);
 * } else {
 *   console.error('Deserialization failed:', result.error);
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { Price, Quantity, type Side } from '@polymarket/value-objects';
import { ValidationError } from '@polymarket/errors';
import type { FillId } from '@polymarket/ids';
import { asOrderId, asFillId, parseAssetId } from '@polymarket/ids';
import Decimal from 'decimal.js';
import type { Order } from '../Order';
import { Order as OrderClass } from '../Order';
import type { OrderStatus } from '../value-objects/OrderStatus';
import { OrderFill } from '../value-objects/OrderFill';

/**
 * JSON представление Order (из API/БД)
 *
 * @remarks
 * Соответствует формату OrderViewModel.toJSON()
 */
export interface OrderJSON {
  readonly id: string;
  readonly asset: unknown; // AssetId — парсится через parseAssetId()
  readonly side: Side;
  readonly price: number;
  readonly size: number;
  readonly status: OrderStatus;
  readonly timestamp: string; // ISO string
  readonly strategyId?: string;
  readonly fill?: {
    readonly filledSize: number;
    readonly averageFillPrice?: number;
    readonly fillIds: readonly string[];
  };
  readonly reason?: string;
}

/**
 * Класс OrderDeserializer - десериализация JSON в Order
 */
export class OrderDeserializer {
  /**
   * Приватный конструктор - static-only class
   */
  private constructor() {
    throw new Error('OrderDeserializer is a static class');
  }

  /**
   * Десериализует JSON в Order объект
   *
   * @param json - Plain object из API/БД
   * @returns Result<Order, ValidationError>
   *
   * @remarks
   * Создает все value objects из примитивов.
   * Валидирует данные через Order.create().
   *
   * Обрабатывает:
   * - timestamp: string → Date
   * - price: number → Price
   * - size: number → Quantity
   * - fill: object → OrderFill
   *
   * @example
   * ```typescript
   * const json = {
   *   id: 'order-123',
   *   marketId: 'market-1',
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   price: 0.65,
   *   size: 100,
   *   status: 'OPEN',
   *   timestamp: '2024-01-01T00:00:00.000Z'
   * };
   *
   * const result = OrderDeserializer.fromJSON(json);
   * if (result.ok) {
   *   console.log(result.value.price.value); // 0.65
   * }
   * ```
   */
  public static fromJSON(json: OrderJSON): Result<Order, ValidationError> {
    try {
      if (!json || typeof json !== 'object') {
        return Err(new ValidationError('Invalid JSON: must be an object', { context: { json } }));
      }

      // Валидация и парсинг OrderId
      const orderId = asOrderId(json.id);
      if (!orderId) {
        return Err(new ValidationError('Invalid order ID format', {
          context: { field: 'id', value: json.id },
        }));
      }

      // Парсинг AssetId
      const asset = parseAssetId(JSON.stringify(json.asset));
      if (!asset) {
        return Err(new ValidationError('Invalid asset format', {
          context: { field: 'asset', orderId: json.id, value: json.asset },
        }));
      }

      // Создание Price и Quantity value objects (бросают исключение при невалидных данных)
      const price = Price.of(new Decimal(json.price));
      const size = Quantity.of(new Decimal(json.size));

      // Парсинг timestamp
      const timestamp = new Date(json.timestamp);
      if (isNaN(timestamp.getTime())) {
        return Err(new ValidationError('Invalid timestamp format', {
          context: { field: 'timestamp', orderId: json.id, value: json.timestamp },
        }));
      }

      // Создание OrderFill (если есть)
      let fill: OrderFill | undefined;
      if (json.fill) {
        const filledSize = Quantity.of(new Decimal(json.fill.filledSize));
        const averageFillPrice = json.fill.averageFillPrice !== undefined
          ? Price.of(new Decimal(json.fill.averageFillPrice))
          : undefined;

        // Парсинг FillId[] из string[]
        const fillIds: FillId[] = [];
        for (const rawId of json.fill.fillIds) {
          const fillId = asFillId(rawId);
          if (!fillId) {
            return Err(new ValidationError(`Invalid fill ID format: ${rawId}`, {
              context: { field: 'fill.fillIds', orderId: json.id },
            }));
          }
          fillIds.push(fillId);
        }

        const fillResult = OrderFill.create(filledSize, averageFillPrice, fillIds, size);

        if (!fillResult.ok) {
          return Err(new ValidationError(`Invalid fill: ${fillResult.error.message}`, {
            context: { field: 'fill', orderId: json.id },
          }));
        }

        fill = fillResult.value;
      }

      // Создание Order через factory method
      return OrderClass.create({
        id: orderId,
        asset,
        side: json.side,
        price,
        size,
        status: json.status,
        timestamp,
        strategyId: json.strategyId,
        fill,
        reason: json.reason,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Err(new ValidationError(`Deserialization failed: ${msg}`, {
        context: { orderId: json?.id },
      }));
    }
  }

  /**
   * Десериализует массив JSON объектов
   *
   * @param jsonArray - Массив plain objects
   * @returns Result<Order[], ValidationError>
   *
   * @remarks
   * Останавливается на первой ошибке.
   * Если нужна частичная загрузка, используйте fromJSONPartial().
   *
   * @example
   * ```typescript
   * const jsonArray = [
   *   { id: 'order-1', ... },
   *   { id: 'order-2', ... }
   * ];
   *
   * const result = OrderDeserializer.fromJSONArray(jsonArray);
   * if (result.ok) {
   *   console.log(`Loaded ${result.value.length} orders`);
   * }
   * ```
   */
  public static fromJSONArray(jsonArray: readonly OrderJSON[]): Result<Order[], ValidationError> {
    if (!Array.isArray(jsonArray)) {
      return Err(
        new ValidationError('Invalid JSON array: must be an array', {
          context: { jsonArray },
        })
      );
    }

    const orders: Order[] = [];

    for (let i = 0; i < jsonArray.length; i++) {
      const result = this.fromJSON(jsonArray[i]);
      if (!result.ok) {
        return Err(
          new ValidationError(`Failed to deserialize order at index ${i}: ${result.error.message}`, {
            context: { index: i, json: jsonArray[i] },
          })
        );
      }
      orders.push(result.value);
    }

    return Ok(orders);
  }

  /**
   * Десериализует массив с пропуском ошибок
   *
   * @param jsonArray - Массив plain objects
   * @returns Успешно загруженные Order объекты
   *
   * @remarks
   * Пропускает невалидные записи.
   * Логирует ошибки в console.warn.
   * Используйте когда нужна частичная загрузка.
   *
   * @example
   * ```typescript
   * const jsonArray = [
   *   { id: 'order-1', ... }, // валидный
   *   { id: 'order-2', price: -1, ... }, // невалидный
   *   { id: 'order-3', ... }  // валидный
   * ];
   *
   * const orders = OrderDeserializer.fromJSONPartial(jsonArray);
   * console.log(orders.length); // 2 (пропустили order-2)
   * ```
   */
  public static fromJSONPartial(jsonArray: readonly OrderJSON[]): Order[] {
    if (!Array.isArray(jsonArray)) {
      console.warn('OrderDeserializer.fromJSONPartial: input is not an array');
      return [];
    }

    const orders: Order[] = [];

    for (let i = 0; i < jsonArray.length; i++) {
      const result = this.fromJSON(jsonArray[i]);
      if (result.ok) {
        orders.push(result.value);
      } else {
        console.warn(
          `OrderDeserializer.fromJSONPartial: skipped order at index ${i}:`,
          result.error.message
        );
      }
    }

    return orders;
  }
}
