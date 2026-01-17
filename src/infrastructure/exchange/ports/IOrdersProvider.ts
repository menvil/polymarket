/**
 * Generic orders provider interface (PLURAL!)
 *
 * @remarks
 * Orders provider abstracts orders data access.
 * Provides read-only access to open orders and order history.
 *
 * **IMPORTANT**: This is plural "Orders" (not singular "Order")
 * because it manages multiple orders.
 *
 * **NOTE**: This provider is read-only. For placing/canceling orders,
 * use IExecutionAdapter.
 *
 * **Use cases**:
 * - Get open orders
 * - Get order by ID
 * - Get order history
 * - Monitor order status
 *
 * @example
 * ```typescript
 * const provider = new PolymarketOrdersProvider(orderClient, mapper, logger);
 *
 * const openOrders = await provider.getOpenOrders();
 * console.log(`Open orders: ${openOrders.length}`);
 *
 * const order = await provider.getOrderById('order-123');
 * console.log(`Order status: ${order.status}`);
 * ```
 */

/**
 * Order response (normalized)
 */
export interface OrderResponse {
  /** Order ID */
  orderId: string;

  /** Token ID */
  tokenId: string;

  /** Order side */
  side: 'buy' | 'sell';

  /** Order price */
  price: number;

  /** Original size */
  size: number;

  /** Remaining (unfilled) size */
  sizeRemaining: number;

  /** Order status */
  status: 'open' | 'partially_filled' | 'filled' | 'cancelled';

  /** Created timestamp (ms) */
  createdAt: number;

  /** Updated timestamp (ms) */
  updatedAt?: number;
}

/**
 * Generic orders provider interface (PLURAL!)
 */
export interface IOrdersProvider {
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
  getOpenOrders(tokenId?: string): Promise<OrderResponse[]>;

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
  getOrderById(orderId: string): Promise<OrderResponse>;

  /**
   * Get order history (filled and cancelled orders)
   *
   * @param tokenId - Optional: filter by token ID
   * @param limit - Optional: max number of orders to return
   * @returns Array of historical orders
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Optional method. Returns filled and cancelled orders.
   *
   * @example
   * ```typescript
   * const history = await provider.getOrderHistory('0x123', 100);
   * console.log(`Last 100 orders for token 0x123: ${history.length}`);
   * ```
   */
  getOrderHistory?(tokenId?: string, limit?: number): Promise<OrderResponse[]>;

  /**
   * Get orders by status
   *
   * @param status - Order status to filter
   * @param tokenId - Optional: filter by token ID
   * @returns Array of orders with specified status
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Optional method. Returns orders filtered by status.
   *
   * @example
   * ```typescript
   * const filledOrders = await provider.getOrdersByStatus('filled');
   * console.log(`Filled orders: ${filledOrders.length}`);
   * ```
   */
  getOrdersByStatus?(
    status: 'open' | 'partially_filled' | 'filled' | 'cancelled',
    tokenId?: string
  ): Promise<OrderResponse[]>;
}
