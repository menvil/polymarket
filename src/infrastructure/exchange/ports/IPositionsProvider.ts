/**
 * Generic positions provider interface (PLURAL!)
 *
 * @remarks
 * Positions provider abstracts positions data access.
 * Positions are filled trades, NOT open orders.
 *
 * **IMPORTANT**: This is plural "Positions" (not singular "Position")
 * because it manages multiple positions.
 *
 * **Use cases**:
 * - Get current positions (filled trades)
 * - Calculate unrealized PnL
 * - Check position limits
 * - Display portfolio summary
 *
 * @example
 * ```typescript
 * const provider = new PolymarketPositionsProvider(positionsClient, mapper, logger);
 *
 * const positions = await provider.getPositions();
 * console.log(`Total positions: ${positions.length}`);
 *
 * const state = await provider.getPositionState('0x123');
 * console.log(`Current: ${state.currentPosition}, Limit: ${state.positionLimit}`);
 * ```
 */

/**
 * Position response (normalized)
 */
export interface PositionResponse {
  /** Token ID */
  tokenId: string;

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
 * Position state (for validation)
 */
export interface PositionState {
  /** Current position size */
  currentPosition: number;

  /** Position limit (max size) */
  positionLimit: number;

  /** Whether position can be increased */
  canIncrease: boolean;

  /** Whether position can be decreased */
  canDecrease: boolean;
}

/**
 * Generic positions provider interface (PLURAL!)
 */
export interface IPositionsProvider {
  /**
   * Get current positions (filled trades)
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of positions
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns filled trades, NOT open orders.
   * For open orders, use IOrdersProvider.
   *
   * @example
   * ```typescript
   * const positions = await provider.getPositions();
   * console.log(`Total positions: ${positions.length}`);
   *
   * const btcPositions = await provider.getPositions('BTC-USD');
   * console.log(`BTC position: ${btcPositions[0].size}`);
   * ```
   */
  getPositions(tokenId?: string): Promise<PositionResponse[]>;

  /**
   * Get position state for specific token
   *
   * @param tokenId - Token ID
   * @returns Position state with limits
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Used for validation before placing orders.
   * Checks current position size and limits.
   *
   * @example
   * ```typescript
   * const state = await provider.getPositionState('0x123');
   *
   * if (state.canIncrease) {
   *   console.log(`Can increase position up to ${state.positionLimit}`);
   * }
   * ```
   */
  getPositionState(tokenId: string): Promise<PositionState>;

  /**
   * Get total unrealized PnL across all positions
   *
   * @returns Total unrealized PnL
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Optional method. Calculates sum of unrealized PnL for all positions.
   */
  getTotalUnrealizedPnl?(): Promise<number>;

  /**
   * Get total realized PnL across all positions
   *
   * @returns Total realized PnL
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Optional method. Calculates sum of realized PnL for all closed positions.
   */
  getTotalRealizedPnl?(): Promise<number>;
}
