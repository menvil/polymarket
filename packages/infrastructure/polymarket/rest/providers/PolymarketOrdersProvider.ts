/**
 * Polymarket Orders Provider (PLURAL!)
 *
 * @remarks
 * Implements IOrdersProvider interface.
 * Uses PolymarketOrderRestClient + PolymarketOrderMapper.
 *
 * **IMPORTANT**: This is plural "Orders" (not singular "Order")
 * because it manages multiple orders.
 *
 * **NOTE**: This provider is read-only. For placing/canceling orders,
 * use PolymarketExecutionAdapter.
 *
 * Responsibilities:
 * - Fetch orders data from API
 * - Normalize data using mapper
 * - Return domain-formatted orders
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
 * Polymarket Orders Provider (PLURAL!)
 *
 * @remarks
 * Implements IOrdersProvider for Polymarket.
 */
export class PolymarketOrdersProvider implements IOrdersProvider {
  constructor(
    private readonly orderClient: PolymarketOrderRestClient,
    private readonly mapper: PolymarketOrderMapper,
    private readonly logger: ILogger
  ) {}

  /**
   * Get all open orders
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of open orders
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns only orders with status 'open' or 'partially_filled'.
   * Filled and cancelled orders are excluded.
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
   * Get specific order by ID
   *
   * @param orderId - Order ID
   * @returns Order response
   * @throws {ApiError} If API call fails or order not found
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
   * Get orders by status
   *
   * @param status - Order status to filter
   * @param tokenId - Optional: filter by token ID
   * @returns Array of orders with specified status
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Filters orders by status locally (after fetching all open orders).
   * For 'filled' and 'cancelled' orders, use getOrderHistory() if available.
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
