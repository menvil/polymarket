/**
 * Polymarket Portfolio Adapter
 *
 * @remarks
 * Handles balance, positions, and allowance queries.
 * Uses BalancePolicy + MarketConstraintsPolicy internally.
 * Implements IPortfolioAdapter.
 *
 * **IMPORTANT**: This adapter does NOT handle orderbook or market data.
 * Use MarketDataAdapter for that.
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

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type {
  IPortfolioAdapter,
  PositionResponse,
  CanPlaceOrderParams,
  CanPlaceOrderResult,
} from '../../../exchange/ports/IPortfolioAdapter.js';
import type { IBalanceProvider } from '../../../exchange/ports/IBalanceProvider.js';
import type { IPositionsProvider } from '../../../exchange/ports/IPositionsProvider.js';
import type { PolymarketMarketConstraintsPolicy } from '../policies/PolymarketMarketConstraintsPolicy.js';
import type { PolymarketBalancePolicy } from '../policies/PolymarketBalancePolicy.js';

/**
 * Polymarket Portfolio Adapter
 *
 * @remarks
 * Implements IPortfolioAdapter for Polymarket.
 */
export class PolymarketPortfolioAdapter implements IPortfolioAdapter {
  constructor(
    private readonly balanceProvider: IBalanceProvider,
    private readonly positionsProvider: IPositionsProvider,
    private readonly balancePolicy: PolymarketBalancePolicy,
    private readonly constraintsPolicy: PolymarketMarketConstraintsPolicy,
    private readonly logger: ILogger
  ) {}

  /**
   * Get available USDC balance
   *
   * @returns Available USDC balance
   * @throws {ApiError} If API call fails
   */
  async getBalance(): Promise<number> {
    this.logger.debug('Getting balance');

    const balance = await this.balanceProvider.getAvailableBalance();

    this.logger.debug('Balance retrieved', { balance });

    return balance;
  }

  /**
   * Get outcome token balance for specific token
   *
   * @param tokenId - Token ID
   * @returns Outcome token balance
   * @throws {ApiError} If API call fails
   */
  async getOutcomeBalance(tokenId: string): Promise<number> {
    this.logger.debug('Getting outcome balance', { tokenId });

    const balance = await this.balanceProvider.getOutcomeBalance(tokenId);

    this.logger.debug('Outcome balance retrieved', {
      tokenId,
      balance,
    });

    return balance;
  }

  /**
   * Get current positions (filled trades)
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of positions
   * @throws {ApiError} If API call fails
   */
  async getPositions(tokenId?: string): Promise<PositionResponse[]> {
    // v7.7.14: Removed duplicate logs (logged in PolymarketPositionsRestClient)
    const positions = await this.positionsProvider.getPositions(tokenId);
    return positions;
  }

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
   * Flow:
   * 1. Normalize size via MarketConstraintsPolicy
   * 2. Validate size against constraints (min/max)
   * 3. Check balance via BalancePolicy
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
  async canPlaceOrder(params: CanPlaceOrderParams): Promise<CanPlaceOrderResult> {
    const { tokenId, side, price, size } = params;

    this.logger.debug('Checking if order can be placed', {
      tokenId,
      side,
      price,
      size,
    });

    // Step 1: Normalize size via MarketConstraintsPolicy
    const normalizedSize = await this.constraintsPolicy.normalizeSize(tokenId, size);

    this.logger.debug('Size normalized', {
      original: size,
      normalized: normalizedSize,
    });

    // Step 1.5: Normalize price via MarketConstraintsPolicy (CRITICAL FIX)
    const normalizedPrice = await this.constraintsPolicy.normalizePrice(tokenId, price);

    // Get priceTick from constraints for API builder
    const constraints = await this.constraintsPolicy.getConstraints(tokenId);

    this.logger.debug('Price normalized', {
      original: price,
      normalized: normalizedPrice,
      priceTick: constraints.priceTick,
    });

    // Step 2: Validate size against constraints
    const sizeValidation = await this.constraintsPolicy.validateSize(
      tokenId,
      normalizedSize,
      normalizedPrice,
      side
    );

    if (!sizeValidation.ok) {
      this.logger.warn('Size validation failed', {
        tokenId,
        size: normalizedSize,
        price: normalizedPrice,
        side,
        reason: sizeValidation.reason,
        minShares: sizeValidation.minShares,
      });

      return { ok: false, reason: sizeValidation.reason };
    }

    // Step 3: Check balance via BalancePolicy
    const balanceCheck = await this.balancePolicy.checkBalance({
      tokenId,
      side,
      price: normalizedPrice,
      size: normalizedSize,
      minOrderSize: constraints.minOrderSize, // Pass market's minimum order size
    });

    if (!balanceCheck.ok) {
      this.logger.warn('Balance check failed', {
        tokenId,
        side,
        price: normalizedPrice,
        size: normalizedSize,
        reason: balanceCheck.reason,
        suggestedSize: balanceCheck.suggestedSize,
      });

      return { ok: false, reason: balanceCheck.reason };
    }

    // Use suggestedSize if balance check provided it (e.g., selling exact available balance)
    const finalSize = balanceCheck.suggestedSize ?? normalizedSize;

    // Get fee rate (learned from errors or default)
    const feeRateBps = this.constraintsPolicy.getFeeRateBps(tokenId);

    this.logger.debug('Order can be placed', {
      tokenId,
      side,
      price: normalizedPrice,
      normalizedSize,
      finalSize,
      priceTick: constraints.priceTick,
      feeRateBps,
    });

    return {
      ok: true,
      normalizedSize: finalSize,
      normalizedPrice,
      feeRateBps,
      priceTick: constraints.priceTick,
    };
  }

  /**
   * Approve USDC for trading (blockchain call)
   *
   * @param amount - Amount to approve
   * @throws {BlockchainError} If blockchain call fails
   *
   * @remarks
   * This is a blockchain transaction, not an API call.
   * May require gas fees.
   *
   * TODO: Implement blockchain integration.
   */
  async approveUSDC(amount: number): Promise<void> {
    this.logger.warn('approveUSDC not yet implemented', { amount });

    // TODO: Implement blockchain integration
    throw new Error('approveUSDC not yet implemented');
  }

  /**
   * Get current USDC allowance
   *
   * @returns Current allowance amount
   * @throws {BlockchainError} If blockchain call fails
   *
   * @remarks
   * TODO: Implement blockchain integration.
   */
  async getAllowance(): Promise<number> {
    this.logger.warn('getAllowance not yet implemented');

    // TODO: Implement blockchain integration
    throw new Error('getAllowance not yet implemented');
  }
}
