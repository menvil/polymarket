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
   */
  async getAvailableBalance(): Promise<number> {
    if (this.simulationMode) {
      return this.getSimulatedBalance('available');
    }

    this.logger.debug('Getting available balance');
    const rawBalances = await this.balanceClient.getBalances();
    const normalized = this.mapper.toDomainBalances(rawBalances);

    this.logger.debug('Available balance retrieved', { availableUSDC: normalized.availableUSDC });
    return normalized.availableUSDC;
  }

  /**
   * Получить баланс токенов исхода для конкретного токена
   *
   * @param tokenId - ID токена
   * @returns Баланс токенов исхода
   * @throws {ApiError} Если вызов API завершился неудачей
   */
  async getOutcomeBalance(tokenId: string): Promise<number> {
    if (this.simulationMode) {
      this.logger.debug('Getting outcome balance (SIMULATION MODE)', { tokenId, balance: 0 });
      return 0;
    }

    this.logger.debug('Getting outcome balance', { tokenId });
    const balance = await this.balanceClient.getOutcomeTokenBalance(tokenId);

    this.logger.debug('Outcome balance retrieved', { tokenId, balance });
    return balance;
  }

  /**
   * Получить заблокированный баланс (в открытых заказах)
   *
   * @returns Заблокированный баланс USDC
   * @throws {ApiError} Если вызов API завершился неудачей
   */
  async getLockedBalance(): Promise<number> {
    if (this.simulationMode) {
      return this.getSimulatedBalance('locked');
    }

    this.logger.debug('Getting locked balance');
    const rawBalances = await this.balanceClient.getBalances();
    const normalized = this.mapper.toDomainBalances(rawBalances);

    this.logger.debug('Locked balance retrieved', { lockedUSDC: normalized.lockedUSDC });
    return normalized.lockedUSDC;
  }

  /**
   * Получить общий баланс (доступный + заблокированный)
   *
   * @returns Общий баланс USDC
   * @throws {ApiError} Если вызов API завершился неудачей
   */
  async getTotalBalance(): Promise<number> {
    if (this.simulationMode) {
      return this.getSimulatedBalance('total');
    }

    this.logger.debug('Getting total balance');
    const rawBalances = await this.balanceClient.getBalances();
    const normalized = this.mapper.toDomainBalances(rawBalances);

    this.logger.debug('Total balance retrieved', { totalUSDC: normalized.totalUSDC });
    return normalized.totalUSDC;
  }

  /**
   * Получить симулированный баланс для режима симуляции
   *
   * @param type - Тип баланса ('available' | 'locked' | 'total')
   * @returns Виртуальный баланс
   */
  private getSimulatedBalance(type: 'available' | 'locked' | 'total'): number {
    const VIRTUAL_BALANCE = 1_000_000; // 1М USDC
    const balance = type === 'locked' ? 0 : VIRTUAL_BALANCE;

    this.logger.debug(`Getting ${type} balance (SIMULATION MODE)`, { balance });
    return balance;
  }
}
