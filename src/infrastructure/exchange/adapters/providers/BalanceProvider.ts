/**
 * BalanceProvider - adapter для получения баланса через PolymarketBalanceRestClient
 *
 * @remarks
 * Реализует IBalanceProvider интерфейс для ValidationContextProvider.
 * Делает HTTP запросы к Polymarket API для получения баланса.
 *
 * @example
 * ```typescript
 * const balanceProvider = new BalanceProvider(balanceClient, logger);
 * const balance = await balanceProvider.getAvailableBalance();
 * console.log(`Available: $${balance}`);
 * ```
 */

import type { IBalanceProvider } from '../../../../application/execution/ValidationContextProvider.js';
import type { PolymarketBalanceRestClient } from '../../clients/PolymarketBalanceRestClient.js';
import type { ILogger } from '../../../../domain/ports/ILogger.js';

/**
 * BalanceProvider - adapter для IBalanceProvider
 *
 * @remarks
 * Использует PolymarketBalanceRestClient для HTTP запросов.
 * Кэширование НЕ реализовано (можно добавить позже).
 */
export class BalanceProvider implements IBalanceProvider {
  /**
   * Создаёт BalanceProvider
   *
   * @param balanceClient - REST client для получения балансов
   * @param logger - Logger для structured logging
   */
  constructor(
    private readonly balanceClient: PolymarketBalanceRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Получает доступный баланс USDC
   *
   * @returns Доступный баланс USDC
   *
   * @remarks
   * Делает HTTP запрос к Polymarket API.
   * Возвращает available balance (не total, не locked).
   *
   * @example
   * ```typescript
   * const balance = await balanceProvider.getAvailableBalance();
   * // 1234.56 (USDC)
   * ```
   */
  public async getAvailableBalance(): Promise<number> {
    try {
      // Get all balances and find USDC
      const balances = await this.balanceClient.getBalances();
      const usdcBalance = balances.find((b) => b.asset === 'USDC');

      if (!usdcBalance) {
        this.logger.warn('[BalanceProvider] USDC balance not found, returning 0');
        return 0;
      }

      // Parse available balance (decimal string → number)
      const available = parseFloat(usdcBalance.available);

      this.logger.debug('[BalanceProvider] Balance fetched', {
        balance: available.toFixed(2),
      });

      return available;
    } catch (error) {
      this.logger.error('[BalanceProvider] Failed to fetch balance', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Re-throw error (caller will handle it)
      throw error;
    }
  }
}
