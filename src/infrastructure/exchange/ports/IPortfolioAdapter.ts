/**
 * Generic portfolio adapter interface
 *
 * @remarks
 * Portfolio adapter handles balance, positions, and allowance queries.
 * It can use policies internally (BalancePolicy, MarketConstraintsPolicy).
 *
 * **IMPORTANT**: This adapter does NOT handle orderbook or market data.
 * Use IMarketDataAdapter for that.
 *
 * Key responsibilities:
 * - Get user balances (USDC, outcome tokens)
 * - Get user positions (filled trades)
 * - Check if order can be placed (uses policies)
 * - Approve USDC for trading (blockchain call)
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketPortfolioAdapter(
 *   balanceProvider,
 *   positionsProvider,
 *   balancePolicy,
 *   constraintsPolicy,
 *   logger
 * );
 *
 * // Check if order can be placed
 * const result = await adapter.canPlaceOrder({
 *   tokenId: '0x123',
 *   side: 'buy',
 *   price: 0.52,
 *   size: 100,
 * });
 *
 * if (result.ok) {
 *   console.log(`Can place order with size ${result.normalizedSize}`);
 * } else {
 *   console.error(`Cannot place order: ${result.reason}`);
 * }
 * ```
 */

/**
 * Position response (normalized)
 */
export interface PositionResponse {
  /** Token ID */
  tokenId: string;

  /** Condition ID (market ID) - used to match with strategy */
  conditionId?: string;

  /** Position size (positive = long, negative = short) */
  size: number;

  /** Average entry price */
  averagePrice: number;

  /** Realized PnL */
  realizedPnl: number;

  /** Unrealized PnL */
  unrealizedPnl: number;

  /** Last update timestamp (ms) */
  updatedAt: number;
}

/**
 * Parameters for checking if order can be placed
 */
export interface CanPlaceOrderParams {
  /** Token ID */
  tokenId: string;

  /** Order side */
  side: 'buy' | 'sell';

  /** Order price */
  price: number;

  /** Order size (will be normalized) */
  size: number;
}

/**
 * Result of canPlaceOrder check
 */
export interface CanPlaceOrderResult {
  /** Whether order can be placed */
  ok: boolean;

  /** Reason if order cannot be placed */
  reason?: string;

  /** Normalized size if order can be placed */
  normalizedSize?: number;

  /** Normalized price if order can be placed (rounded to priceTick) */
  normalizedPrice?: number;

  /** Price tick size from market constraints */
  priceTick?: number;

  /** Fee rate in basis points (learned from errors or default) */
  feeRateBps?: number;
}

/**
 * Generic portfolio adapter interface
 */
export interface IPortfolioAdapter {
  /**
   * Get available USDC balance
   *
   * @returns Available USDC balance
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const balance = await adapter.getBalance();
   * console.log(`Available: ${balance} USDC`);
   * ```
   */
  getBalance(): Promise<number>;

  /**
   * Get outcome token balance for specific token
   *
   * @param tokenId - Token ID
   * @returns Outcome token balance
   * @throws {ApiError} If API call fails
   */
  getOutcomeBalance(tokenId: string): Promise<number>;

  /**
   * Get current positions (filled trades)
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of positions
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Positions are filled trades, NOT open orders.
   * For open orders, use IExecutionAdapter.getOpenOrders().
   */
  getPositions(tokenId?: string): Promise<PositionResponse[]>;

  /**
   * Check if order can be placed (uses policies internally)
   *
   * @param params - Order parameters
   * @returns Result with normalized size or reason for failure
   *
   * @remarks
   * This method uses:
   * - MarketConstraintsPolicy → normalize size, validate constraints
   * - BalancePolicy → check if sufficient balance
   *
   * Returns {ok: true, normalizedSize: ...} if order can be placed.
   * Returns {ok: false, reason: '...'} otherwise.
   *
   * @example
   * ```typescript
   * const result = await adapter.canPlaceOrder({
   *   tokenId: '0x123',
   *   side: 'buy',
   *   price: 0.52,
   *   size: 15.7777,
   * });
   *
   * if (result.ok) {
   *   console.log(`Can place order with size ${result.normalizedSize}`);
   * } else {
   *   console.error(`Cannot place order: ${result.reason}`);
   * }
   * ```
   */
  canPlaceOrder(params: CanPlaceOrderParams): Promise<CanPlaceOrderResult>;

  /**
   * Approve USDC for trading (blockchain call)
   *
   * @param amount - Amount to approve
   * @throws {BlockchainError} If blockchain call fails
   *
   * @remarks
   * This is a blockchain transaction, not an API call.
   * May require gas fees.
   */
  approveUSDC(amount: number): Promise<void>;

  /**
   * Get current USDC allowance
   *
   * @returns Current allowance amount
   * @throws {BlockchainError} If blockchain call fails
   */
  getAllowance(): Promise<number>;
}
