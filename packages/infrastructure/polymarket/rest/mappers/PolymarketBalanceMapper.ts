/**
 * Polymarket Balance Mapper
 *
 * @remarks
 * Maps raw Polymarket API balance responses to domain types.
 *
 * Transformations:
 * - String → number conversion
 * - Field name normalization
 * - Safe defaults for missing fields
 *
 * @example
 * ```typescript
 * const mapper = new PolymarketBalanceMapper(logger);
 *
 * const rawBalance = {
 *   asset: 'USDC',
 *   total: '1000.50',
 *   available: '900.25',
 *   locked: '100.25',
 * };
 *
 * const normalized = mapper.toDomainBalance(rawBalance);
 * // { availableUSDC: 900.25, lockedUSDC: 100.25, totalUSDC: 1000.50 }
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { BalanceResponse } from '../clients/PolymarketBalanceRestClient.js';
import { USDC_MULTIPLIER } from '../constants.js';

/**
 * Normalized balance (domain format)
 */
export interface NormalizedBalance {
  /** Available USDC balance */
  availableUSDC: number;

  /** Locked USDC balance (in open orders) */
  lockedUSDC: number;

  /** Total USDC balance */
  totalUSDC: number;

  /** Outcome token balances (tokenId → balance) */
  outcomeTokens: Record<string, number>;
}

/**
 * Polymarket Balance Mapper
 */
export class PolymarketBalanceMapper {
  constructor(private readonly logger: ILogger) {}

  /**
   * Map balance response to domain format
   *
   * @param response - Raw balance response
   * @returns Normalized balance
   *
   * @example
   * ```typescript
   * const rawBalance = {
   *   asset: 'USDC',
   *   total: '1000.50',
   *   available: '900.25',
   *   locked: '100.25',
   * };
   *
   * const normalized = mapper.toDomainBalance(rawBalance);
   * console.log(`Available: ${normalized.availableUSDC}`);
   * ```
   */
  toDomainBalance(response: BalanceResponse): NormalizedBalance {
    const available = this.parseBalance(response.available);
    const locked = this.parseBalance(response.locked);
    const total = this.parseBalance(response.total);

    return {
      availableUSDC: available,
      lockedUSDC: locked,
      totalUSDC: total,
      outcomeTokens: {},
    };
  }

  /**
   * Map multiple balance responses to domain format
   *
   * @param responses - Array of raw balance responses
   * @returns Normalized balance with outcome tokens
   *
   * @example
   * ```typescript
   * const balances = await balanceClient.getBalances();
   * const normalized = mapper.toDomainBalances(balances);
   *
   * console.log(`USDC: ${normalized.availableUSDC}`);
   * console.log(`Outcome tokens: ${Object.keys(normalized.outcomeTokens).length}`);
   * ```
   */
  toDomainBalances(responses: BalanceResponse[]): NormalizedBalance {
    const result: NormalizedBalance = {
      availableUSDC: 0,
      lockedUSDC: 0,
      totalUSDC: 0,
      outcomeTokens: {},
    };

    for (const response of responses) {
      if (response.asset === 'USDC') {
        result.availableUSDC = this.parseBalance(response.available);
        result.lockedUSDC = this.parseBalance(response.locked);
        result.totalUSDC = this.parseBalance(response.total);
      } else {
        // Outcome-токен
        const tokenId = response.asset;
        const balance = this.parseBalance(response.available);
        result.outcomeTokens[tokenId] = balance;
      }
    }

    return result;
  }

  /**
   * Parse balance string to number
   *
   * @param balance - Balance string (in minimum units - 6 decimals for USDC)
   * @returns Parsed number in USDC (divided by 10^6) or 0 if invalid
   *
   * @remarks
   * CRITICAL: Polymarket API returns balance in minimum units (wei-like).
   * USDC has 6 decimal places, so we divide by 1,000,000 to get actual USDC amount.
   *
   * Example:
   * - API returns: "9572736" (minimum units)
   * - Actual balance: 9.572736 USDC (9572736 / 10^6)
   */
  private parseBalance(balance: string): number {
    const parsed = parseFloat(balance);

    if (isNaN(parsed)) {
      this.logger.warn('Invalid balance value', { balance });
      return 0;
    }

    // КРИТИЧНО: Конвертируем из минимальных единиц в USDC (делим на 10^6)
    const balanceInUSDC = parsed / USDC_MULTIPLIER;

    this.logger.debug('Balance converted from minimum units', {
      raw: parsed,
      usdc: balanceInUSDC,
    });

    return balanceInUSDC;
  }
}
