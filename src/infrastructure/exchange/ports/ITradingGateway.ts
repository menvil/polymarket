/**
 * Generic trading gateway interface for any exchange
 *
 * @remarks
 * Implementations should be exchange-specific (e.g., PolymarketTradingGateway).
 * Gateway is a thin layer translating domain → exchange API.
 *
 * The gateway pattern provides a simple abstraction over exchange-specific APIs,
 * allowing the domain layer to remain independent of any particular exchange.
 *
 * @example
 * ```typescript
 * const gateway = new PolymarketTradingGateway(orderClient, mapper, logger);
 *
 * const result = await gateway.placeOrder({
 *   tokenId: '0x123',
 *   side: 'buy',
 *   price: 0.52,
 *   size: 100,
 * });
 *
 * if (result.isOk()) {
 *   console.log(`Order placed: ${result.value.orderId}`);
 * } else {
 *   console.error(`Failed: ${result.error.message}`);
 * }
 * ```
 */

import type { Result } from '../../../shared/types/Result.js';

/**
 * Parameters for placing an order
 */
export interface PlaceOrderParams {
  /** Token ID (asset ID, market ID, or symbol depending on exchange) */
  tokenId: string;

  /** Order side */
  side: 'buy' | 'sell';

  /** Price per unit */
  price: number;

  /** Order size/quantity */
  size: number;
}

/**
 * Order response (normalized across exchanges)
 */
export interface OrderResponse {
  /** Exchange-specific order ID */
  orderId: string;

  /** Token/asset ID */
  tokenId: string;

  /** Order side */
  side: 'buy' | 'sell';

  /** Order price */
  price: number;

  /** Original order size */
  size: number;

  /** Remaining (unfilled) size */
  sizeRemaining: number;

  /** Order status */
  status: 'open' | 'partially_filled' | 'filled' | 'cancelled';

  /** Order creation timestamp (milliseconds) */
  createdAt: number;

  /** Optional: Last update timestamp */
  updatedAt?: number;
}

/**
 * Generic trading gateway interface
 */
export interface ITradingGateway {
  /**
   * Place a new order
   *
   * @param params - Order parameters
   * @returns Result with order response or error
   *
   * @throws Should NOT throw - returns Result type instead
   *
   * @example
   * ```typescript
   * const result = await gateway.placeOrder({
   *   tokenId: '0x123',
   *   side: 'buy',
   *   price: 0.52,
   *   size: 100,
   * });
   * ```
   */
  placeOrder(params: PlaceOrderParams): Promise<Result<OrderResponse, Error>>;

  /**
   * Cancel an existing order
   *
   * @param orderId - Exchange-specific order ID
   * @returns Result with void or error
   *
   * @throws Should NOT throw - returns Result type instead
   */
  cancelOrder(orderId: string): Promise<Result<void, Error>>;

  /**
   * Get all open orders
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Result with array of orders or error
   *
   * @throws Should NOT throw - returns Result type instead
   */
  getOpenOrders(tokenId?: string): Promise<Result<OrderResponse[], Error>>;

  /**
   * Get specific order by ID
   *
   * @param orderId - Exchange-specific order ID
   * @returns Result with order response or error
   *
   * @throws Should NOT throw - returns Result type instead
   */
  getOrderById(orderId: string): Promise<Result<OrderResponse, Error>>;
}
