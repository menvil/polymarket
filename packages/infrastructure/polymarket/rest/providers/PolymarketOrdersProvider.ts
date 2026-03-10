/**
 * Провайдер ордеров Polymarket (множественное число!)
 *
 * @remarks
 * Реализует интерфейс IOrdersProvider.
 * Использует PolymarketOrderRestClient + PolymarketOrderMapper.
 *
 * **ВАЖНО**: Это множественное число "Orders" (не единственное "Order"),
 * поскольку управляет несколькими ордерами.
 *
 * **ПРИМЕЧАНИЕ**: Провайдер доступен только для чтения. Для размещения/отмены ордеров
 * используйте PolymarketExecutionAdapter.
 *
 * Обязанности:
 * - Получение данных ордеров из API
 * - Нормализация данных с помощью маппера
 * - Возврат ордеров в доменном формате
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

import type { ILogger } from '@polymarket/logger';
import type {
  IOrdersProvider,
  OrderResponse,
} from '../../ports/IOrdersProvider.js';
import type { PolymarketOrderRestClient } from '../clients/PolymarketOrderRestClient.js';
import type { PolymarketOrderMapper } from '../mappers/PolymarketOrderMapper.js';

/**
 * Провайдер ордеров Polymarket (множественное число!)
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
   * Получить все открытые ордера
   *
   * @param tokenId - Опционально: фильтр по идентификатору токена
   * @returns Массив открытых ордеров
   * @throws {ApiError} При ошибке вызова API
   *
   * @remarks
   * Возвращает только ордера со статусом 'open' или 'partially_filled'.
   * Исполненные и отменённые ордера исключаются.
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
   * Получить конкретный ордер по идентификатору
   *
   * @param orderId - Идентификатор ордера
   * @returns Ответ по ордеру
   * @throws {ApiError} При ошибке вызова API или если ордер не найден
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
   * Получить ордера по статусу
   *
   * @param status - Статус ордера для фильтрации
   * @param tokenId - Опционально: фильтр по идентификатору токена
   * @returns Массив ордеров с указанным статусом
   * @throws {ApiError} При ошибке вызова API
   *
   * @remarks
   * Фильтрует ордера по статусу локально (после получения всех открытых ордеров).
   * Для ордеров со статусом 'filled' и 'cancelled' используйте getOrderHistory() если доступен.
   *
   * @example
   * ```typescript
   * const partiallyFilled = await provider.getOrdersByStatus('partially_filled');
   * console.log(`Partially filled orders: ${partiallyFilled.length}`);
   * ```
   */
  async getOrdersByStatus(
    status: 'open' | 'partially_filled' | 'filled' | 'cancelled',
    tokenId?: string
  ): Promise<OrderResponse[]> {
    this.logger.debug('Getting orders by status', { status, tokenId });

    // Получаем открытые ордера (включает 'open' и 'partially_filled')
    const openOrders = await this.getOpenOrders(tokenId);

    // Фильтруем по статусу
    const filtered = openOrders.filter((order) => order.status === status);

    this.logger.debug('Orders by status retrieved', {
      status,
      count: filtered.length,
    });

    return filtered;
  }
}
