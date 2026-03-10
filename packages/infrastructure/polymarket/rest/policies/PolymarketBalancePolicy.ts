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

import type { ILogger } from '@polymarket/logger';
import type { IBalanceProvider } from '../../ports/IBalanceProvider.js';
import type { IPortfolioProjector } from '../../ports/IPortfolioProjector.js';

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
  /**
   * @param balanceProvider - REST API баланса (источник истины для USDC BUY-ордеров)
   * @param logger - Logger
   * @param portfolioProjector - Опциональный event-sourced проектор инвентаря.
   *   Если передан — используется для SELL-ордеров вместо Balance API (zero-lag).
   *   Если не передан — SELL-ордера проверяются через Balance API (может запаздывать 0–5 сек после BUY fill).
   *
   * @remarks
   * Стратегия проверки баланса:
   * - **BUY**: всегда Balance API (USDC) — PortfolioProjector не отслеживает USDC
   * - **SELL с portfolioProjector**: event-sourced инвентарь — мгновенно, без сетевых запросов
   * - **SELL без portfolioProjector**: Balance API — работает, но может не видеть только что купленные токены
   */
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

    // Нормализуем сторону в нижний регистр для сравнения
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
      // Вычисляем максимальный доступный размер при текущем балансе
      let suggestedSize = Math.floor(availableUSDC / price);

      // Проверяем что предложенный размер соответствует минимальному требованию
      const minOrderSize = params.minOrderSize ?? 1;
      if (suggestedSize < minOrderSize) {
        suggestedSize = 0; // Не хватает баланса на минимальный размер ордера
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

    // Пробуем PortfolioProjector первым (мгновенно, без задержки)
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
      // Fallback к Balance API (может отставать после мгновенных fills)
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

      // Если дефицит незначительный (< 1%), продаём доступный баланс (ошибка округления/комиссия)
      if (deficitPercent < 1 && availableTokens > 0) {
        // КРИТИЧНО: SELL ордера требуют makerAmount (size) с не более 2 знаками после запятой
        // Округляем вниз до 2 знаков чтобы избежать ошибки API 400
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
          suggestedSize: roundedSize, // Округлено до 2 знаков (требование API)
        };
      }

      const reason = `Insufficient outcome tokens: have ${availableTokens.toFixed(
        2
      )}, need ${requiredTokens.toFixed(2)}`;

      // Округляем доступные токены до 2 знаков (требование API для SELL ордеров)
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
    // Пробуем PortfolioProjector первым (мгновенно, без задержки)
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
      // Fallback к Balance API (может отставать после мгновенных fills)
      availableTokens = await this.balanceProvider.getOutcomeBalance(tokenId);

      this.logger.debug('Calculated max sell size (Balance API)', {
        tokenId: tokenId.substring(0, 16) + '...',
        availableTokens,
        source: 'BalanceAPI',
      });
    }

    // Округляем вниз до 2 знаков (требование API для SELL ордеров)
    const roundedSize = Math.floor(availableTokens * 100) / 100;

    this.logger.debug('Max sell size (rounded)', {
      tokenId: tokenId.substring(0, 16) + '...',
      availableTokens,
      maxSize: roundedSize,
    });

    return roundedSize;
  }
}
