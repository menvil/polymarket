/**
 * Order Mapper для конвертации между API и Domain Order
 *
 * @remarks
 * Конвертирует данные ордеров между:
 * - Polymarket CLOB API формат → Domain Order entity
 * - Domain Order entity → Polymarket CLOB API формат
 *
 * Алгоритм маппинга:
 * 1. Конвертирует строковые значения (price, size) в Value Objects (Price, Quantity)
 * 2. Маппит статусы API (PENDING/LIVE/FILLED/CANCELLED) → Domain (PENDING/OPEN/FILLED/CANCELED)
 * 3. Конвертирует timestamp (Unix seconds → Date)
 * 4. Обрабатывает частичное заполнение (filledSize, averageFillPrice)
 *
 * @example
 * ```typescript
 * // API → Domain
 * const apiOrder = {
 *   orderId: '0x123',
 *   tokenId: '0xabc',
 *   side: 'BUY',
 *   price: '0.55',
 *   size: '100',
 *   filledSize: '40',
 *   status: 'LIVE',
 *   timestamp: 1640000000
 * };
 * const domainOrder = OrderMapper.toDomain(apiOrder);
 *
 * // Domain → API
 * const apiParams = OrderMapper.toApi(domainOrder);
 * ```
 */

import { Order, OrderSide, OrderStatus } from '../../../domain/entities/Order.js';
import { Price } from '../../../domain/value-objects/Price.js';
import { Quantity } from '../../../domain/value-objects/Quantity.js';
import type { PlaceOrderResponse } from '../clients/CLOBClient.js';

/**
 * API Order данные от Polymarket CLOB
 */
export interface ApiOrder {
  /** ID ордера */
  orderId: string;
  /** ID токена */
  tokenId: string;
  /** Сторона */
  side: 'BUY' | 'SELL';
  /** Цена (строка) */
  price: string;
  /** Размер (строка) */
  size: string;
  /** Заполненный размер (строка) */
  filledSize: string;
  /** Статус API */
  status: 'PENDING' | 'LIVE' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  /** Timestamp в секундах */
  timestamp: number;
  /** Средняя цена заполнения (опционально) */
  averageFillPrice?: string;
}

/**
 * Order Mapper
 *
 * @remarks
 * Статический класс для конвертации ордеров.
 * Все методы статические, не требует инстанцирования.
 */
export class OrderMapper {
  /**
   * Конвертирует API ордер в Domain Order entity
   *
   * @param apiOrder - Ордер от Polymarket API
   * @returns Domain Order entity
   * @throws {Error} При ошибке парсинга или валидации
   *
   * @remarks
   * Алгоритм:
   * 1. Парсит строковые значения price/size в числа
   * 2. Создаёт Value Objects (Price, Quantity)
   * 3. Маппит статус API → Domain
   * 4. Конвертирует Unix timestamp → Date
   * 5. Обрабатывает filledSize и averageFillPrice если есть
   * 6. Создаёт и валидирует Domain Order entity
   *
   * @example
   * ```typescript
   * const apiOrder = {
   *   orderId: '0x123',
   *   tokenId: '0xabc',
   *   side: 'BUY',
   *   price: '0.55',
   *   size: '100',
   *   filledSize: '0',
   *   status: 'LIVE',
   *   timestamp: 1640000000
   * };
   *
   * const order = OrderMapper.toDomain(apiOrder);
   * console.log(order.side); // 'BUY'
   * console.log(order.price.value); // 0.55
   * console.log(order.status); // 'OPEN'
   * ```
   */
  public static toDomain(apiOrder: ApiOrder): Order {
    // Парсим price и size
    const price = Price.fromNumber(parseFloat(apiOrder.price));
    const size = Quantity.fromNumber(parseFloat(apiOrder.size));

    // Парсим filledSize если есть
    const filledSizeValue = parseFloat(apiOrder.filledSize);
    const filledSize = filledSizeValue > 0 ? Quantity.fromNumber(filledSizeValue) : undefined;

    // Парсим averageFillPrice если есть
    const averageFillPrice =
      apiOrder.averageFillPrice && filledSizeValue > 0
        ? Price.fromNumber(parseFloat(apiOrder.averageFillPrice))
        : undefined;

    // Маппим статус API → Domain
    const status = this.mapApiStatusToDomain(apiOrder.status);

    // Конвертируем timestamp (секунды → Date)
    const timestamp = new Date(apiOrder.timestamp * 1000);

    // Создаём Domain Order
    return Order.create({
      id: apiOrder.orderId,
      tokenId: apiOrder.tokenId,
      side: apiOrder.side as OrderSide,
      price,
      size,
      status,
      timestamp,
      filledSize,
      averageFillPrice,
    });
  }

  /**
   * Конвертирует PlaceOrderResponse в Domain Order entity
   *
   * @param response - Ответ от CLOB API при создании ордера
   * @returns Domain Order entity
   *
   * @remarks
   * Специализированный метод для обработки ответа API при размещении ордера.
   * Использует тот же алгоритм что и toDomain().
   *
   * @example
   * ```typescript
   * const response = await clobClient.placeOrder({...});
   * const order = OrderMapper.fromPlaceOrderResponse(response);
   * ```
   */
  public static fromPlaceOrderResponse(response: PlaceOrderResponse): Order {
    return this.toDomain({
      orderId: response.orderId,
      tokenId: response.tokenId,
      side: response.side,
      price: response.price,
      size: response.size,
      filledSize: response.filledSize,
      status: response.status,
      timestamp: response.timestamp,
    });
  }

  /**
   * Конвертирует Domain Order в параметры для API
   *
   * @param order - Domain Order entity
   * @returns Параметры для размещения ордера через API
   *
   * @remarks
   * Конвертирует обратно: Domain → API формат.
   * Используется при размещении новых ордеров.
   *
   * @example
   * ```typescript
   * const order = Order.create({...});
   * const apiParams = OrderMapper.toApi(order);
   * await clobClient.placeOrder(apiParams);
   * ```
   */
  public static toApi(order: Order): {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: string;
    size: string;
    orderType: 'LIMIT';
  } {
    return {
      tokenId: order.tokenId,
      side: order.side,
      price: order.price.value.toString(),
      size: order.size.value.toString(),
      orderType: 'LIMIT',
    };
  }

  /**
   * Маппит статус API → Domain статус
   *
   * @param apiStatus - Статус от Polymarket API
   * @returns Domain OrderStatus
   *
   * @remarks
   * Маппинг:
   * - PENDING → PENDING
   * - LIVE → OPEN
   * - FILLED → FILLED
   * - CANCELLED → CANCELED (note: API uses CANCELLED, Domain uses CANCELED)
   * - REJECTED → REJECTED
   *
   * @example
   * ```typescript
   * const status = OrderMapper.mapApiStatusToDomain('LIVE');
   * console.log(status); // 'OPEN'
   * ```
   */
  private static mapApiStatusToDomain(
    apiStatus: 'PENDING' | 'LIVE' | 'FILLED' | 'CANCELLED' | 'REJECTED'
  ): OrderStatus {
    switch (apiStatus) {
      case 'PENDING':
        return 'PENDING';
      case 'LIVE':
        return 'OPEN';
      case 'FILLED':
        return 'FILLED';
      case 'CANCELLED':
        return 'CANCELED'; // Note: API uses "CANCELLED", Domain uses "CANCELED"
      case 'REJECTED':
        return 'REJECTED';
      default:
        throw new Error(`Unknown API order status: ${apiStatus}`);
    }
  }

  /**
   * Маппит Domain статус → API статус
   *
   * @param domainStatus - Domain OrderStatus
   * @returns API статус
   *
   * @remarks
   * Обратный маппинг для toApi().
   *
   * @example
   * ```typescript
   * const apiStatus = OrderMapper.mapDomainStatusToApi('OPEN');
   * console.log(apiStatus); // 'LIVE'
   * ```
   */
  public static mapDomainStatusToApi(
    domainStatus: OrderStatus
  ): 'PENDING' | 'LIVE' | 'FILLED' | 'CANCELLED' | 'REJECTED' {
    switch (domainStatus) {
      case 'PENDING':
        return 'PENDING';
      case 'OPEN':
        return 'LIVE';
      case 'FILLED':
        return 'FILLED';
      case 'CANCELED':
        return 'CANCELLED'; // Note: Domain uses "CANCELED", API uses "CANCELLED"
      case 'REJECTED':
        return 'REJECTED';
      default:
        throw new Error(`Unknown domain order status: ${domainStatus}`);
    }
  }

  /**
   * Создаёт массив Domain Orders из массива API ордеров
   *
   * @param apiOrders - Массив ордеров от API
   * @returns Массив Domain Order entities
   *
   * @remarks
   * Batch-конвертация с фильтрацией ошибок.
   * Ордера с ошибками парсинга пропускаются.
   *
   * @example
   * ```typescript
   * const apiOrders = await clobClient.getOrders();
   * const orders = OrderMapper.toDomainMany(apiOrders);
   * console.log(`Parsed ${orders.length} orders`);
   * ```
   */
  public static toDomainMany(apiOrders: ApiOrder[]): Order[] {
    const orders: Order[] = [];

    for (const apiOrder of apiOrders) {
      try {
        orders.push(this.toDomain(apiOrder));
      } catch (error) {
        // Пропускаем ордера с ошибками парсинга
        console.error(`Failed to parse order ${apiOrder.orderId}:`, error);
      }
    }

    return orders;
  }
}
