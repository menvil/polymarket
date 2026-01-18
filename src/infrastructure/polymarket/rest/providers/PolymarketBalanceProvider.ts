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
  /** Виртуальный баланс для режима симуляции (1М USDC) */
  private static readonly VIRTUAL_BALANCE = 1_000_000;

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
      return this.getSimulatedBalance('outcome', tokenId);
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
   * @param type - Тип баланса ('available' | 'locked' | 'total' | 'outcome')
   * @param tokenId - ID токена (только для типа 'outcome')
   * @returns Виртуальный баланс
   */
  private getSimulatedBalance(type: 'available' | 'locked' | 'total' | 'outcome', tokenId?: string): number {
    if (type === 'outcome' && !tokenId) {
      this.logger.warn('Getting outcome balance (SIMULATION MODE) without tokenId');
      return 0;
    }

    const balance =
      type === 'locked' || type === 'outcome' ? 0 : PolymarketBalanceProvider.VIRTUAL_BALANCE;

    const logContext = tokenId ? { balance, tokenId } : { balance };
    this.logger.debug(`Getting ${type} balance (SIMULATION MODE)`, logContext);
    return balance;
  }
}
