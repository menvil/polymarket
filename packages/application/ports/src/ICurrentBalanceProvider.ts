/**
 * Порт: провайдер текущего баланса от venue.
 *
 * @remarks
 * Используется InitializePortfolioUseCase для инициализации Portfolio
 * на основе актуального баланса из REST API биржи.
 *
 * Реализация в infrastructure layer:
 * `PolymarketCurrentBalanceAdapter` → `PolymarketBalanceProvider.getAvailableBalance()`
 * (уже возвращает `Money` — адаптер является чистым passthrough, без
 * промежуточного `Money.toNumber() → new Decimal(...)` раунд-трипа, который
 * ранее вносил потерю точности, см. Этап 10c плана миграции).
 *
 * @example
 * ```typescript
 * const usdcBalance = await balanceProvider.getUsdcBalance(accountId);
 * // → Money.of(new Decimal('1500.00'), 'USDC')
 * ```
 */
import type { AccountId } from '@polymarket/ids';
import type { Money } from '@polymarket/value-objects';

/**
 * Порт: получение текущего USDC-баланса аккаунта от venue.
 */
export interface ICurrentBalanceProvider {
  /**
   * Возвращает текущий доступный USDC-баланс аккаунта.
   *
   * @param accountId - ID аккаунта
   * @returns Текущий доступный баланс (Money, USDC)
   * @throws При ошибке REST API
   */
  getUsdcBalance(accountId: AccountId): Promise<Money>;
}
