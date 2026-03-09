/**
 * Polymarket Positions Provider (PLURAL!)
 *
 * @remarks
 * Implements IPositionsProvider interface.
 * Uses PolymarketPositionsRestClient + PolymarketPositionMapper.
 *
 * **IMPORTANT**: This is plural "Positions" (not singular "Position")
 * because it manages multiple positions.
 *
 * Responsibilities:
 * - Fetch positions data from API
 * - Normalize data using mapper
 * - Return domain-formatted positions
 *
 * @example
 * ```typescript
 * const provider = new PolymarketPositionsProvider(
 *   positionsClient,
 *   mapper,
 *   logger
 * );
 *
 * const positions = await provider.getPositions();
 * console.log(`Total positions: ${positions.length}`);
 *
 * const state = await provider.getPositionState('0x123');
 * console.log(`Current: ${state.currentPosition}`);
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type {
  IPositionsProvider,
  PositionResponse,
  PositionState,
} from '../../../exchange/ports/IPositionsProvider.js';
import type { PolymarketPositionsRestClient } from '../clients/PolymarketPositionsRestClient.js';
import type { PolymarketPositionMapper } from '../mappers/PolymarketPositionMapper.js';

/**
 * Polymarket Positions Provider (PLURAL!)
 *
 * @remarks
 * Implements IPositionsProvider for Polymarket.
 */
export class PolymarketPositionsProvider implements IPositionsProvider {
  constructor(
    private readonly positionsClient: PolymarketPositionsRestClient,
    private readonly mapper: PolymarketPositionMapper,
    private readonly logger: ILogger
  ) {}

  /**
   * Get current positions (filled trades)
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of positions
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns filled trades, NOT open orders.
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
  async getPositions(tokenId?: string): Promise<PositionResponse[]> {
    this.logger.debug('Getting positions', { tokenId });

    // Дублирующий лог удалён (логируется в PolymarketPositionsRestClient)
    const rawPositions = await this.positionsClient.getPositions(tokenId);
    const normalized = this.mapper.toDomainPositions(rawPositions);
    return normalized;
  }

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
  async getPositionState(tokenId: string): Promise<PositionState> {
    this.logger.debug('Getting position state', { tokenId });

    const rawPosition = await this.positionsClient.getPositionForAsset(tokenId);

    const currentPosition = rawPosition
      ? this.mapper.toDomainPosition(rawPosition).size
      : 0;

    // Лимит позиции по умолчанию (можно настроить)
    const positionLimit = 1000;

    const canIncrease = Math.abs(currentPosition) < positionLimit;
    const canDecrease = currentPosition !== 0;

    this.logger.debug('Position state retrieved', {
      tokenId,
      currentPosition,
      positionLimit,
      canIncrease,
      canDecrease,
    });

    return {
      currentPosition,
      positionLimit,
      canIncrease,
      canDecrease,
    };
  }

  /**
   * Get total unrealized PnL across all positions
   *
   * @returns Total unrealized PnL
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const unrealizedPnl = await provider.getTotalUnrealizedPnl();
   * console.log(`Total unrealized PnL: ${unrealizedPnl}`);
   * ```
   */
  async getTotalUnrealizedPnl(): Promise<number> {
    this.logger.debug('Getting total unrealized PnL');

    const positions = await this.getPositions();
    const totalUnrealizedPnl = positions.reduce(
      (sum, position) => sum + position.unrealizedPnl,
      0
    );

    this.logger.debug('Total unrealized PnL calculated', {
      totalUnrealizedPnl,
      positionsCount: positions.length,
    });

    return totalUnrealizedPnl;
  }

  /**
   * Get total realized PnL across all positions
   *
   * @returns Total realized PnL
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const realizedPnl = await provider.getTotalRealizedPnl();
   * console.log(`Total realized PnL: ${realizedPnl}`);
   * ```
   */
  async getTotalRealizedPnl(): Promise<number> {
    this.logger.debug('Getting total realized PnL');

    const positions = await this.getPositions();
    const totalRealizedPnl = positions.reduce(
      (sum, position) => sum + position.realizedPnl,
      0
    );

    this.logger.debug('Total realized PnL calculated', {
      totalRealizedPnl,
      positionsCount: positions.length,
    });

    return totalRealizedPnl;
  }
}
