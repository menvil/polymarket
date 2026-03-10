/**
 * Провайдер баланса Polymarket
 *
 * @remarks
 * Реализует интерфейс IBalanceProvider.
 * Использует PolymarketBalanceRestClient + PolymarketBalanceMapper.
 *
 * Обязанности:
 * - Получение данных баланса из API
 * - Нормализация данных с помощью маппера
 * - Возврат балансов в доменном формате
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

import type { ILogger } from '@polymarket/logger';
import type { IBalanceProvider } from '../../ports/IBalanceProvider.js';
import type { PolymarketBalanceRestClient } from '../clients/PolymarketBalanceRestClient.js';
import type { PolymarketBalanceMapper } from '../mappers/PolymarketBalanceMapper.js';

/**
 * Провайдер баланса Polymarket
 *
 * @remarks
 * Реализует IBalanceProvider для Polymarket.
 */
export class PolymarketBalanceProvider implements IBalanceProvider {
  constructor(
    private readonly balanceClient: PolymarketBalanceRestClient,
    private readonly mapper: PolymarketBalanceMapper,
    private readonly logger: ILogger,
    private readonly simulationMode: boolean = false
  ) {}

  /**
   * Получить доступный баланс USDC
   *
   * @returns Доступный баланс USDC (НЕ заблокированный в открытых ордерах)
   * @throws {ApiError} При ошибке вызова API
   *
   * @example
   * ```typescript
   * const balance = await provider.getAvailableBalance();
   * console.log(`Available: ${balance} USDC`);
   * ```
   */
  async getAvailableBalance(): Promise<number> {
    // В режиме симуляции возвращаем виртуальный баланс без вызова API
    if (this.simulationMode) {
      const virtualBalance = 1000000; // 1M USDC виртуальный баланс
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
   * Получить баланс outcome-токена для конкретного токена
   *
   * @param tokenId - Идентификатор токена
   * @returns Баланс outcome-токена
   * @throws {ApiError} При ошибке вызова API
   *
   * @example
   * ```typescript
   * const balance = await provider.getOutcomeBalance('0x123');
   * console.log(`Outcome tokens: ${balance}`);
   * ```
   */
  async getOutcomeBalance(tokenId: string): Promise<number> {
    // В режиме симуляции возвращаем виртуальный баланс outcome-токенов
    if (this.simulationMode) {
      const virtualOutcomeBalance = 0; // Изначально нет outcome-токенов
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
   * Получить заблокированный баланс (в открытых ордерах)
   *
   * @returns Заблокированный баланс USDC
   * @throws {ApiError} При ошибке вызова API
   *
   * @example
   * ```typescript
   * const locked = await provider.getLockedBalance();
   * console.log(`Locked in orders: ${locked} USDC`);
   * ```
   */
  async getLockedBalance(): Promise<number> {
    // В режиме симуляции возвращаем виртуальный заблокированный баланс
    if (this.simulationMode) {
      const virtualLockedBalance = 0; // В симуляции нет заблокированного баланса
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
   * Получить общий баланс (доступный + заблокированный)
   *
   * @returns Общий баланс USDC
   * @throws {ApiError} При ошибке вызова API
   *
   * @example
   * ```typescript
   * const total = await provider.getTotalBalance();
   * console.log(`Total: ${total} USDC`);
   * ```
   */
  async getTotalBalance(): Promise<number> {
    // В режиме симуляции возвращаем виртуальный общий баланс
    if (this.simulationMode) {
      const virtualTotalBalance = 1000000; // 1M USDC итого
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
