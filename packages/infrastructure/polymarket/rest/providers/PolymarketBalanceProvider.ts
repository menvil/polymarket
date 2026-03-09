/**
 * Polymarket Balance Provider
 *
 * @remarks
 * Implements IBalanceProvider interface.
 * Uses PolymarketBalanceRestClient + PolymarketBalanceMapper.
 *
 * Responsibilities:
 * - Fetch balance data from API
 * - Normalize data using mapper
 * - Return domain-formatted balances
 *
 * @example
 * ```typescript
 * const provider = new PolymarketBalanceProvider(
 *   balanceClient,
 *   mapper,
 *   logger
 * );
 *
 * const availableUSDC = await provider.getAvailableBalance();
 * console.log(`Available: ${availableUSDC} USDC`);
 *
 * const outcomeBalance = await provider.getOutcomeBalance('0x123');
 * console.log(`Outcome tokens: ${outcomeBalance}`);
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { IBalanceProvider } from '../../../exchange/ports/IBalanceProvider.js';
import type { PolymarketBalanceRestClient } from '../clients/PolymarketBalanceRestClient.js';
import type { PolymarketBalanceMapper } from '../mappers/PolymarketBalanceMapper.js';

/**
 * Polymarket Balance Provider
 *
 * @remarks
 * Implements IBalanceProvider for Polymarket.
 */
export class PolymarketBalanceProvider implements IBalanceProvider {
  constructor(
    private readonly balanceClient: PolymarketBalanceRestClient,
    private readonly mapper: PolymarketBalanceMapper,
    private readonly logger: ILogger,
    private readonly simulationMode: boolean = false
  ) {}

  /**
   * Get available USDC balance
   *
   * @returns Available USDC balance (NOT locked in open orders)
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const balance = await provider.getAvailableBalance();
   * console.log(`Available: ${balance} USDC`);
   * ```
   */
  async getAvailableBalance(): Promise<number> {
    // In simulation mode, return virtual balance without API call
    if (this.simulationMode) {
      const virtualBalance = 1000000; // 1M USDC virtual balance
      this.logger.debug('Getting available balance (SIMULATION MODE)', {
        virtualBalance,
      });
      return virtualBalance;
    }

    this.logger.debug('Getting available balance');

    const rawBalances = await this.balanceClient.getBalances();
    const normalized = this.mapper.toDomainBalances(rawBalances);

    this.logger.debug('Available balance retrieved', {
      availableUSDC: normalized.availableUSDC,
    });

    return normalized.availableUSDC;
  }

  /**
   * Get outcome token balance for specific token
   *
   * @param tokenId - Token ID
   * @returns Outcome token balance
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const balance = await provider.getOutcomeBalance('0x123');
   * console.log(`Outcome tokens: ${balance}`);
   * ```
   */
  async getOutcomeBalance(tokenId: string): Promise<number> {
    // In simulation mode, return virtual outcome balance
    if (this.simulationMode) {
      const virtualOutcomeBalance = 0; // No outcome tokens initially
      this.logger.debug('Getting outcome balance (SIMULATION MODE)', {
        tokenId,
        virtualOutcomeBalance,
      });
      return virtualOutcomeBalance;
    }

    this.logger.debug('Getting outcome balance', { tokenId });

    const balance = await this.balanceClient.getOutcomeTokenBalance(tokenId);

    this.logger.debug('Outcome balance retrieved', {
      tokenId,
      balance,
    });

    return balance;
  }

  /**
   * Get locked balance (in open orders)
   *
   * @returns Locked USDC balance
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const locked = await provider.getLockedBalance();
   * console.log(`Locked in orders: ${locked} USDC`);
   * ```
   */
  async getLockedBalance(): Promise<number> {
    // In simulation mode, return virtual locked balance
    if (this.simulationMode) {
      const virtualLockedBalance = 0; // No locked balance in simulation
      this.logger.debug('Getting locked balance (SIMULATION MODE)', {
        virtualLockedBalance,
      });
      return virtualLockedBalance;
    }

    this.logger.debug('Getting locked balance');

    const rawBalances = await this.balanceClient.getBalances();
    const normalized = this.mapper.toDomainBalances(rawBalances);

    this.logger.debug('Locked balance retrieved', {
      lockedUSDC: normalized.lockedUSDC,
    });

    return normalized.lockedUSDC;
  }

  /**
   * Get total balance (available + locked)
   *
   * @returns Total USDC balance
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const total = await provider.getTotalBalance();
   * console.log(`Total: ${total} USDC`);
   * ```
   */
  async getTotalBalance(): Promise<number> {
    // In simulation mode, return virtual total balance
    if (this.simulationMode) {
      const virtualTotalBalance = 1000000; // 1M USDC total
      this.logger.debug('Getting total balance (SIMULATION MODE)', {
        virtualTotalBalance,
      });
      return virtualTotalBalance;
    }

    this.logger.debug('Getting total balance');

    const rawBalances = await this.balanceClient.getBalances();
    const normalized = this.mapper.toDomainBalances(rawBalances);

    this.logger.debug('Total balance retrieved', {
      totalUSDC: normalized.totalUSDC,
    });

    return normalized.totalUSDC;
  }
}
