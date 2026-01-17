/**
 * Generic balance provider interface
 *
 * @remarks
 * Balance provider abstracts balance data access.
 * This is a lightweight interface for querying user balances.
 *
 * Implementations should use REST clients or other data sources
 * to fetch balance information.
 *
 * **Use cases**:
 * - Check available USDC before placing order
 * - Check outcome token balance before selling
 * - Display portfolio summary
 * - Validate trading operations
 *
 * @example
 * ```typescript
 * const provider = new PolymarketBalanceProvider(balanceClient, mapper, logger);
 *
 * const usdcBalance = await provider.getAvailableBalance();
 * console.log(`Available: ${usdcBalance} USDC`);
 *
 * const outcomeBalance = await provider.getOutcomeBalance('0x123');
 * console.log(`Outcome tokens: ${outcomeBalance}`);
 * ```
 */

/**
 * Generic balance provider interface
 */
export interface IBalanceProvider {
  /**
   * Get available USDC balance
   *
   * @returns Available USDC balance (NOT locked in open orders)
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * This should return the balance available for trading.
   * Locked balance in open orders should be excluded.
   *
   * @example
   * ```typescript
   * const balance = await provider.getAvailableBalance();
   * console.log(`Available: ${balance} USDC`);
   * ```
   */
  getAvailableBalance(): Promise<number>;

  /**
   * Get outcome token balance for specific token
   *
   * @param tokenId - Token ID (asset ID, market ID, or symbol)
   * @returns Outcome token balance
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns the balance of outcome tokens for a specific market.
   * This is used when selling outcome tokens.
   *
   * @example
   * ```typescript
   * const balance = await provider.getOutcomeBalance('0x123');
   * console.log(`Outcome tokens: ${balance}`);
   * ```
   */
  getOutcomeBalance(tokenId: string): Promise<number>;

  /**
   * Get locked balance (in open orders)
   *
   * @returns Locked USDC balance
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Optional method. Returns balance locked in open orders.
   * Total balance = available + locked.
   */
  getLockedBalance?(): Promise<number>;

  /**
   * Get total balance (available + locked)
   *
   * @returns Total USDC balance
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Optional method. Returns total balance including locked funds.
   */
  getTotalBalance?(): Promise<number>;
}
