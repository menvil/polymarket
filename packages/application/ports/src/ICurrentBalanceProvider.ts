/**
 * Порт: провайдер текущего баланса от venue.
 *
 * @remarks
 * Используется InitializePortfolioUseCase для инициализации Portfolio
 * на основе актуального баланса из REST API биржи.
 *
 * Реализация в infrastructure layer:
 * `PolymarketCurrentBalanceAdapter` → `PolymarketBalanceProvider.getAvailableBalance()`
 *
 * @example
 * ```typescript
 * const usdcBalance = await balanceProvider.getUsdcBalance(accountId);
 * // → Decimal('1500.00')
 * ```
 */
import type Decimal from 'decimal.js';
import type { AccountId } from '@polymarket/ids';

/**
 * Порт: получение текущего USDC-баланса аккаунта от venue.
 */
export interface ICurrentBalanceProvider {
  /**
   * Возвращает текущий доступный USDC-баланс аккаунта.
   *
   * @param accountId - ID аккаунта
   * @returns Текущий доступный баланс (Decimal)
   * @throws При ошибке REST API
   */
  getUsdcBalance(accountId: AccountId): Promise<Decimal>;
}
