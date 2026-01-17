/**
 * Провайдер балансов Polymarket
 *
 * @remarks
 * Реализует интерфейс IBalanceProvider.
 * Использует PolymarketBalanceRestClient + PolymarketBalanceMapper.
 *
 * Обязанности:
 * - Получение данных о балансах из API
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

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { IBalanceProvider } from '../../../exchange/ports/IBalanceProvider.js';
import type { PolymarketBalanceRestClient } from '../clients/PolymarketBalanceRestClient.js';
import type { PolymarketBalanceMapper } from '../mappers/PolymarketBalanceMapper.js';

/**
 * Провайдер балансов Polymarket
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
   * @returns Доступный баланс USDC (НЕ заблокированный в открытых заказах)
   * @throws {ApiError} Если вызов API завершился неудачей
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
      const virtualBalance = 1000000; // 1М USDC виртуальный баланс
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
   * Получить баланс токенов исхода для конкретного токена
   *
   * @param tokenId - ID токена
   * @returns Баланс токенов исхода
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @example
   * ```typescript
   * const balance = await provider.getOutcomeBalance('0x123');
   * console.log(`Outcome tokens: ${balance}`);
   * ```
   */
  async getOutcomeBalance(tokenId: string): Promise<number> {
    // В режиме симуляции возвращаем виртуальный баланс исхода
    if (this.simulationMode) {
      const virtualOutcomeBalance = 0; // Нет токенов исхода изначально
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
   * Получить заблокированный баланс (в открытых заказах)
   *
   * @returns Заблокированный баланс USDC
   * @throws {ApiError} Если вызов API завершился неудачей
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
      const virtualLockedBalance = 0; // Нет заблокированного баланса в симуляции
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
   * @throws {ApiError} Если вызов API завершился неудачей
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
      const virtualTotalBalance = 1000000; // 1М USDC всего
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
