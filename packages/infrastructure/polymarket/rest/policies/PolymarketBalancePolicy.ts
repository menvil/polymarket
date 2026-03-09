/**
 * Polymarket Balance Policy
 *
 * @remarks
 * Checks if user has sufficient USDC and outcome tokens to place order.
 *
 * This policy is used by PortfolioAdapter.canPlaceOrder() to validate
 * balance BEFORE sending order to API.
 *
 * Validation logic:
 * - BUY order: requires USDC (price * size)
 * - SELL order: requires outcome tokens (size)
 *
 * @example
 * ```typescript
 * const policy = new PolymarketBalancePolicy(balanceProvider, logger);
 *
 * const result = await policy.checkBalance({
 *   tokenId: '0x123',
 *   side: 'buy',
 *   price: 0.52,
 *   size: 100,
 * });
 *
 * if (!result.ok) {
 *   console.error(result.reason);
 *   // "Insufficient USDC: have 50, need 52"
 * }
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { IBalanceProvider } from '../../../exchange/ports/IBalanceProvider.js';
import type { IPortfolioProjector } from '../../../../domain/services/portfolio/PortfolioProjector.js';

/**
 * Balance check parameters
 */
export interface BalanceCheckParams {
  /** Token ID */
  tokenId: string;

  /** Order side */
  side: 'buy' | 'sell';

  /** Order price */
  price: number;

  /** Order size */
  size: number;

  /** Minimum order size from market constraints (optional) */
  minOrderSize?: number;
}

/**
 * Balance check result
 */
export interface BalanceCheckResult {
  /** Whether balance is sufficient */
  ok: boolean;

  /** Reason if insufficient */
  reason?: string;

  /** Required amount */
  required?: number;

  /** Available amount */
  available?: number;

  /** Suggested size (maximum affordable with current balance) */
  suggestedSize?: number;
}

/**
 * Polymarket Balance Policy
 */
export class PolymarketBalancePolicy {
  constructor(
    private readonly balanceProvider: IBalanceProvider,
    private readonly logger: ILogger,
    private readonly portfolioProjector?: IPortfolioProjector
  ) {}

  /**
   * Check if order can be placed (balance check)
   *
   * @param params - Balance check parameters
   * @returns Check result
   *
   * @example
   * ```typescript
   * const result = await policy.checkBalance({
   *   tokenId: '0x123',
   *   side: 'buy',
   *   price: 0.52,
   *   size: 100,
   * });
   *
   * if (result.ok) {
   *   console.log('Sufficient balance');
   * } else {
   *   console.error(result.reason);
   * }
   * ```
   */
  async checkBalance(params: BalanceCheckParams): Promise<BalanceCheckResult> {
    const { tokenId, side, price, size } = params;

    this.logger.debug('Checking balance', {
      tokenId,
      side,
      price,
      size,
      minOrderSize: params.minOrderSize,
    });

    // Normalize side to lowercase for comparison
    const normalizedSide = side.toLowerCase();

    if (normalizedSide === 'buy') {
      return this.checkBuyBalance(params);
    } else {
      return this.checkSellBalance(tokenId, size);
    }
  }

  /**
   * Check balance for BUY order
   *
   * @param params - Balance check parameters
   * @returns Check result
   *
   * @remarks
   * BUY order requires USDC: required = price * size
   */
  private async checkBuyBalance(
    params: BalanceCheckParams
  ): Promise<BalanceCheckResult> {
    const { price, size } = params;
    const requiredUSDC = price * size;
    const availableUSDC = await this.balanceProvider.getAvailableBalance();

    this.logger.debug('Checking buy balance', {
      requiredUSDC,
      availableUSDC,
    });

    if (availableUSDC < requiredUSDC) {
      // Calculate maximum affordable size with current balance
      let suggestedSize = Math.floor(availableUSDC / price);

      // Check if suggested size meets minimum requirement
      const minOrderSize = params.minOrderSize ?? 1;
      if (suggestedSize < minOrderSize) {
        suggestedSize = 0; // Cannot afford minimum order size
      }

      const reason = `Insufficient USDC: have ${availableUSDC.toFixed(
        2
      )}, need ${requiredUSDC.toFixed(2)}`;

      this.logger.warn('Insufficient balance for buy order', {
        requiredUSDC,
        availableUSDC,
        deficit: requiredUSDC - availableUSDC,
        suggestedSize,
        minOrderSize,
      });

      return {
        ok: false,
        reason,
        required: requiredUSDC,
        available: availableUSDC,
        suggestedSize,
      };
    }

    this.logger.debug('Sufficient balance for buy order', {
      requiredUSDC,
      availableUSDC,
      surplus: availableUSDC - requiredUSDC,
    });

    return { ok: true };
  }

  /**
   * Check balance for SELL order
   *
   * @param tokenId - Token ID
   * @param size - Order size
   * @returns Check result
   *
   * @remarks
   * v7.6: Uses PortfolioProjector FIRST (instant, no lag), then Balance API as fallback.
   *
   * SELL order requires outcome tokens: required = size
   * If balance is slightly less (< 1% deficit), suggests selling available balance
   *
   * **Why PortfolioProjector first?**
   * - PortfolioProjector = event sourced (instant, always up-to-date)
   * - Balance API = external API (may lag 0-5 seconds after fills)
   * - After instant BUY fill, Balance API may still return 0 while PortfolioProjector is correct
   */
  private async checkSellBalance(
    tokenId: string,
    size: number
  ): Promise<BalanceCheckResult> {
    const requiredTokens = size;

    // ✅ v7.6: Try PortfolioProjector first (instant, no lag)
    let availableTokens: number;
    let balanceSource: 'PortfolioProjector' | 'BalanceAPI';

    if (this.portfolioProjector) {
      const position = this.portfolioProjector.getPosition(tokenId);
      availableTokens = position?.quantity ?? 0;
      balanceSource = 'PortfolioProjector';

      this.logger.debug('Checking sell balance (PortfolioProjector - instant)', {
        tokenId: tokenId.substring(0, 16) + '...',
        requiredTokens,
        availableTokens,
        source: balanceSource,
      });
    } else {
      // Fallback to Balance API (may lag after instant fills)
      availableTokens = await this.balanceProvider.getOutcomeBalance(tokenId);
      balanceSource = 'BalanceAPI';

      this.logger.debug('Checking sell balance (Balance API - may lag)', {
        tokenId: tokenId.substring(0, 16) + '...',
        requiredTokens,
        availableTokens,
        source: balanceSource,
      });
    }

    if (availableTokens < requiredTokens) {
      const deficit = requiredTokens - availableTokens;
      const deficitPercent = (deficit / requiredTokens) * 100;

      // If deficit is tiny (< 1%), just sell available balance (rounding/fee error)
      if (deficitPercent < 1 && availableTokens > 0) {
        // CRITICAL: SELL orders require makerAmount (size) with max 2 decimals
        // Round down to 2 decimals to avoid API 400 error
        const roundedSize = Math.floor(availableTokens * 100) / 100;

        this.logger.warn('Tiny deficit in sell balance - using available balance', {
          tokenId,
          requiredTokens,
          availableTokens,
          deficit,
          deficitPercent: `${deficitPercent.toFixed(3)}%`,
          roundedSize,
        });

        return {
          ok: true,
          available: availableTokens,
          suggestedSize: roundedSize, // Rounded to 2 decimals (API requirement)
        };
      }

      const reason = `Insufficient outcome tokens: have ${availableTokens.toFixed(
        2
      )}, need ${requiredTokens.toFixed(2)}`;

      // Round available tokens to 2 decimals (API requirement for SELL orders)
      const roundedAvailable = Math.floor(availableTokens * 100) / 100;

      this.logger.warn('Insufficient balance for sell order', {
        tokenId,
        requiredTokens,
        availableTokens,
        deficit,
        roundedAvailable,
      });

      return {
        ok: false,
        reason,
        required: requiredTokens,
        available: availableTokens,
        suggestedSize: roundedAvailable, // Rounded to 2 decimals
      };
    }

    this.logger.debug('Sufficient balance for sell order', {
      tokenId,
      requiredTokens,
      availableTokens,
      surplus: availableTokens - requiredTokens,
    });

    return { ok: true };
  }

  /**
   * Check if user has ANY USDC balance
   *
   * @returns True if balance > 0
   *
   * @remarks
   * Quick check for bot shutdown conditions.
   *
   * @example
   * ```typescript
   * const hasBalance = await policy.hasAnyBalance();
   * if (!hasBalance) {
   *   console.log('No USDC balance - pausing bot');
   * }
   * ```
   */
  async hasAnyBalance(): Promise<boolean> {
    const availableUSDC = await this.balanceProvider.getAvailableBalance();
    return availableUSDC > 0;
  }

  /**
   * Get maximum order size for given price
   *
   * @param price - Order price
   * @returns Maximum size that can be bought with available USDC
   *
   * @remarks
   * Useful for calculating max position size.
   *
   * @example
   * ```typescript
   * const maxSize = await policy.getMaxBuySize(0.52);
   * console.log(`Max buy size at 0.52: ${maxSize}`);
   * ```
   */
  async getMaxBuySize(price: number): Promise<number> {
    if (price <= 0) {
      return 0;
    }

    const availableUSDC = await this.balanceProvider.getAvailableBalance();
    const maxSize = availableUSDC / price;

    this.logger.debug('Calculated max buy size', {
      price,
      availableUSDC,
      maxSize,
    });

    return maxSize;
  }

  /**
   * Get maximum sell size for token
   *
   * @param tokenId - Token ID
   * @returns Maximum size that can be sold (outcome token balance, rounded to 2 decimals)
   *
   * @remarks
   * v7.6: Uses PortfolioProjector FIRST (instant), then Balance API as fallback.
   *
   * Returns balance rounded DOWN to 2 decimals to comply with API requirements.
   * SELL orders require makerAmount with max 2 decimal places.
   *
   * @example
   * ```typescript
   * const maxSize = await policy.getMaxSellSize('0x123');
   * console.log(`Max sell size: ${maxSize}`); // e.g., 9.99 (not 9.997271)
   * ```
   */
  async getMaxSellSize(tokenId: string): Promise<number> {
    // ✅ v7.6: Try PortfolioProjector first (instant, no lag)
    let availableTokens: number;

    if (this.portfolioProjector) {
      const position = this.portfolioProjector.getPosition(tokenId);
      availableTokens = position?.quantity ?? 0;

      this.logger.debug('Calculated max sell size (PortfolioProjector)', {
        tokenId: tokenId.substring(0, 16) + '...',
        availableTokens,
        source: 'PortfolioProjector',
      });
    } else {
      // Fallback to Balance API (may lag after instant fills)
      availableTokens = await this.balanceProvider.getOutcomeBalance(tokenId);

      this.logger.debug('Calculated max sell size (Balance API)', {
        tokenId: tokenId.substring(0, 16) + '...',
        availableTokens,
        source: 'BalanceAPI',
      });
    }

    // Round down to 2 decimals (API requirement for SELL orders)
    const roundedSize = Math.floor(availableTokens * 100) / 100;

    this.logger.debug('Max sell size (rounded)', {
      tokenId: tokenId.substring(0, 16) + '...',
      availableTokens,
      maxSize: roundedSize,
    });

    return roundedSize;
  }
}
