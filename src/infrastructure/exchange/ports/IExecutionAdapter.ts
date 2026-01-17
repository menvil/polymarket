/**
 * Generic execution adapter interface
 *
 * @remarks
 * Execution adapter is responsible ONLY for API calls.
 * NO validation, NO balance checks, NO normalization.
 *
 * This adapter assumes all parameters are already validated and normalized
 * by policies (BalancePolicy, MarketConstraintsPolicy).
 *
 * Key principle: **Separation of Concerns**
 * - Validation → BalancePolicy, MarketConstraintsPolicy
 * - API calls → ExecutionAdapter
 * - Orchestration → RestAdapter (Facade)
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketExecutionAdapter(orderClient, mapper, logger);
 *
 * // Parameters are already normalized and validated!
 * const order = await adapter.postOrder({
 *   tokenId: '0x123',
 *   side: 'buy',
 *   price: 0.52,
 *   size: 100, // Already rounded to sizeTick
 * });
 *
 * console.log(`Order placed: ${order.orderId}`);
 * ```
 */

/**
 * Parameters for placing an order (already normalized)
 *
 * @remarks
 * v4.2 (Фаза 4): strategyId для multi-strategy изоляции
 * strategyId propagated через: Intent → Context → Adapter → Event
 */
export interface PlaceOrderParams {
  /** Token ID */
  tokenId: string;

  /** Order side */
  side: 'buy' | 'sell';

  /** Price (already validated and normalized) */
  price: number;

  /** Size (already normalized to sizeTick) */
  size: number;

  /** Strategy ID (v4.2: для multi-strategy изоляции, optional для обратной совместимости) */
  strategyId?: string;

  /** Price tick size from market constraints (for API order builder) */
  priceTick?: number;

  /** Fee rate in basis points (from market constraints or learned from errors) */
  feeRateBps?: number;
}

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

  /** Remaining size */
  sizeRemaining: number;

  /** Order status */
  status: 'open' | 'partially_filled' | 'filled' | 'cancelled';

  /** Created timestamp (ms) */
  createdAt: number;

  /** Updated timestamp (ms) */
  updatedAt?: number;
}

/**
 * Fill/trade response (normalized)
 */
export interface FillResponse {
  /** Fill ID */
  fillId: string;

  /** Order ID */
  orderId: string;

  /** Token ID */
  tokenId: string;

  /** Trade side */
  side: 'buy' | 'sell';

  /** Executed price */
  executedPrice: number;

  /** Filled size */
  filledSize: number;

  /** Fee paid */
  fee: number;

  /** Execution timestamp (ms) */
  timestamp: number;
}

/**
 * Generic execution adapter interface
 *
 * @remarks
 * ONLY API calls - no business logic!
 */
export interface IExecutionAdapter {
  /**
   * Place order (ONLY API call, NO validation)
   *
   * @param params - Normalized order parameters (already validated!)
   * @returns Order response
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Assumes:
   * - Size is already normalized (rounded to sizeTick)
   * - Balance is already checked
   * - Price is valid
   *
   * @example
   * ```typescript
   * const order = await adapter.postOrder({
   *   tokenId: '0x123',
   *   side: 'buy',
   *   price: 0.52,
   *   size: 100,
   * });
   * ```
   */
  postOrder(params: PlaceOrderParams): Promise<OrderResponse>;

  /**
   * Cancel order (direct API call)
   *
   * @param orderId - Order ID to cancel
   * @throws {ApiError} If API call fails
   */
  cancelOrder(orderId: string): Promise<void>;

  /**
   * Get open orders (direct API call)
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of open orders (normalized)
   * @throws {ApiError} If API call fails
   */
  getOpenOrders(tokenId?: string): Promise<OrderResponse[]>;

  /**
   * Get fill history
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of fills (normalized)
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns executed trades for the user.
   * This is NOT market trade history - use IMarketDataAdapter for that.
   */
  getFillHistory(tokenId?: string): Promise<FillResponse[]>;
}
