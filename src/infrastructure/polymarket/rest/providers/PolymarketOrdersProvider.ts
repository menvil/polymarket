/**
 * Провайдер заказов Polymarket (МНОЖЕСТВЕННОЕ ЧИСЛО!)
 *
 * @remarks
 * Реализует интерфейс IOrdersProvider.
 * Использует PolymarketOrderRestClient + PolymarketOrderMapper.
 *
 * **ВАЖНО**: Это множественное число "Orders" (не единственное "Order"),
 * потому что он управляет несколькими заказами.
 *
 * **ПРИМЕЧАНИЕ**: Этот провайдер предназначен только для чтения. Для размещения/отмены заказов
 * используйте PolymarketExecutionAdapter.
 *
 * Обязанности:
 * - Получение данных о заказах из API
 * - Нормализация данных с помощью маппера
 * - Возврат заказов в доменном формате
 *
 * @example
 * ```typescript
 * const provider = new PolymarketOrdersProvider(
 *   orderClient,
 *   mapper,
 *   logger
 * );
 *
 * const openOrders = await provider.getOpenOrders();
 * console.log(`Open orders: ${openOrders.length}`);
 *
 * const order = await provider.getOrderById('order-123');
 * console.log(`Order status: ${order.status}`);
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type {
  IOrdersProvider,
  OrderResponse,
  OrderStatus,
} from '../../../exchange/ports/IOrdersProvider.js';
import type { PolymarketOrderRestClient } from '../clients/PolymarketOrderRestClient.js';
import type { PolymarketOrderMapper } from '../mappers/PolymarketOrderMapper.js';

/**
 * Провайдер заказов Polymarket (МНОЖЕСТВЕННОЕ ЧИСЛО!)
 *
 * @remarks
 * Реализует IOrdersProvider для Polymarket.
 */
export class PolymarketOrdersProvider implements IOrdersProvider {
  constructor(
    private readonly orderClient: PolymarketOrderRestClient,
    private readonly mapper: PolymarketOrderMapper,
    private readonly logger: ILogger
  ) {}

  /**
   * Получить все открытые заказы
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив открытых заказов
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Возвращает только заказы со статусом 'OPEN' или 'PARTIALLY_FILLED'.
   * Выполненные и отмененные заказы исключены.
   *
   * @example
   * ```typescript
   * const openOrders = await provider.getOpenOrders();
   * console.log(`Open orders: ${openOrders.length}`);
   *
   * const btcOrders = await provider.getOpenOrders('BTC-USD');
   * console.log(`BTC open orders: ${btcOrders.length}`);
   * ```
   */
  async getOpenOrders(tokenId?: string): Promise<OrderResponse[]> {
    this.logger.debug('Getting open orders', { tokenId });

    const rawOrders = await this.orderClient.getOpenOrders(tokenId);
    const normalized = rawOrders.map((order) => this.mapper.toDomainOrder(order));

    this.logger.debug('Open orders retrieved', {
      count: normalized.length,
    });

    return normalized;
  }

  /**
   * Получить конкретный заказ по ID
   *
   * @param orderId - ID заказа
   * @returns Ответ с заказом
   * @throws {ApiError} Если вызов API завершился неудачей или заказ не найден
   *
   * @example
   * ```typescript
   * const order = await provider.getOrderById('order-123');
   * console.log(`Order status: ${order.status}`);
   * console.log(`Remaining: ${order.sizeRemaining}`);
   * ```
   */
  async getOrderById(orderId: string): Promise<OrderResponse> {
    this.logger.debug('Getting order by ID', { orderId });

    const rawOrder = await this.orderClient.getOrderById(orderId);
    const normalized = this.mapper.toDomainOrder(rawOrder);

    this.logger.debug('Order retrieved', {
      orderId: normalized.orderId,
      status: normalized.status,
    });

    return normalized;
  }

  /**
   * Получить заказы по статусу
   *
   * @param status - Статус заказа для фильтрации (UPPERCASE: 'OPEN', 'PARTIALLY_FILLED', etc.)
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив заказов с указанным статусом
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Фильтрует заказы по статусу локально (после получения всех открытых заказов).
   *
   * @example
   * ```typescript
   * const partiallyFilled = await provider.getOrdersByStatus('PARTIALLY_FILLED');
   * console.log(`Partially filled orders: ${partiallyFilled.length}`);
   * ```
   */
  async getOrdersByStatus(
    status: OrderStatus,
    tokenId?: string
  ): Promise<OrderResponse[]> {
    this.logger.debug('Getting orders by status', { status, tokenId });

    // Получить открытые заказы (включает 'open' и 'partially_filled')
    const openOrders = await this.getOpenOrders(tokenId);

    // Фильтровать по статусу
    const filtered = openOrders.filter((order) => order.status === status);

    this.logger.debug('Orders by status retrieved', {
      status,
      count: filtered.length,
    });

    return filtered;
  }
}
