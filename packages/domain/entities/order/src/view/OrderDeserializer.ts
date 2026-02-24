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
import { OrderValidationError } from '@polymarket/errors';
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
  readonly marketId: string;
  readonly tokenId: string;
  readonly side: Side;
  readonly price: number;
  readonly size: number;
  readonly status: OrderStatus;
  readonly timestamp: string; // ISO string
  readonly strategyId?: string;
  readonly fill?: {
    readonly filledSize: number;
    readonly averageFillPrice?: number;
    readonly tradeIds: readonly string[];
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
   * @returns Result<Order, OrderValidationError>
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
  public static fromJSON(json: OrderJSON): Result<Order, OrderValidationError> {
    // Валидация обязательных полей
    if (!json || typeof json !== 'object') {
      return Err(
        new OrderValidationError('Invalid JSON: must be an object', {
          context: { json },
        })
      );
    }

    // Создание Price value object
    const priceResult = Price.fromValue(json.price);
    if (!priceResult.ok) {
      return Err(
        new OrderValidationError(`Invalid price: ${priceResult.error.message}`, {
          context: { field: 'price', orderId: json.id, value: json.price },
        })
      );
    }

    // Создание Quantity value object
    const sizeResult = Quantity.fromValue(json.size);
    if (!sizeResult.ok) {
      return Err(
        new OrderValidationError(`Invalid size: ${sizeResult.error.message}`, {
          context: { field: 'size', orderId: json.id, value: json.size },
        })
      );
    }

    // Парсинг timestamp
    const timestamp = new Date(json.timestamp);
    if (isNaN(timestamp.getTime())) {
      return Err(
        new OrderValidationError('Invalid timestamp format', {
          context: { field: 'timestamp', orderId: json.id, value: json.timestamp },
        })
      );
    }

    // Создание OrderFill (если есть)
    let fill: OrderFill | undefined;
    if (json.fill) {
      const filledSizeResult = Quantity.fromValue(json.fill.filledSize);
      if (!filledSizeResult.ok) {
        return Err(
          new OrderValidationError(`Invalid fill.filledSize: ${filledSizeResult.error.message}`, {
            context: { field: 'fill.filledSize', orderId: json.id, value: json.fill.filledSize },
          })
        );
      }

      let averageFillPrice: Price | undefined;
      if (json.fill.averageFillPrice !== undefined) {
        const avgPriceResult = Price.fromValue(json.fill.averageFillPrice);
        if (!avgPriceResult.ok) {
          return Err(
            new OrderValidationError(
              `Invalid fill.averageFillPrice: ${avgPriceResult.error.message}`,
              {
                context: {
                  field: 'fill.averageFillPrice',
                  orderId: json.id,
                  value: json.fill.averageFillPrice,
                },
              }
            )
          );
        }
        averageFillPrice = avgPriceResult.value;
      }

      const fillResult = OrderFill.create(
        filledSizeResult.value,
        averageFillPrice,
        json.fill.tradeIds,
        sizeResult.value
      );

      if (!fillResult.ok) {
        return Err(
          new OrderValidationError(`Invalid fill: ${fillResult.error.message}`, {
            context: { field: 'fill', orderId: json.id },
          })
        );
      }

      fill = fillResult.value;
    }

    // Создание Order через factory method
    return OrderClass.create({
      id: json.id,
      marketId: json.marketId,
      tokenId: json.tokenId,
      side: json.side,
      price: priceResult.value,
      size: sizeResult.value,
      status: json.status,
      timestamp,
      strategyId: json.strategyId,
      fill,
      reason: json.reason,
    });
  }

  /**
   * Десериализует массив JSON объектов
   *
   * @param jsonArray - Массив plain objects
   * @returns Result<Order[], OrderValidationError>
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
  public static fromJSONArray(jsonArray: readonly OrderJSON[]): Result<Order[], OrderValidationError> {
    if (!Array.isArray(jsonArray)) {
      return Err(
        new OrderValidationError('Invalid JSON array: must be an array', {
          context: { jsonArray },
        })
      );
    }

    const orders: Order[] = [];

    for (let i = 0; i < jsonArray.length; i++) {
      const result = this.fromJSON(jsonArray[i]);
      if (!result.ok) {
        return Err(
          new OrderValidationError(`Failed to deserialize order at index ${i}: ${result.error.message}`, {
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
