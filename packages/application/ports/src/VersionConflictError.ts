/**
 * Ошибка конфликта версий Portfolio при CAS-сохранении.
 *
 * @remarks
 * Выбрасывается IPortfolioStore.save() когда версия в store
 * не совпадает с ожидаемой. Caller должен перечитать Portfolio и повторить.
 *
 * @example
 * ```typescript
 * const result = store.save(portfolio, expectedVersion);
 * if (!result.ok && result.error instanceof VersionConflictError) {
 *   // Retry: перечитать portfolio и повторить операцию
 *   const fresh = store.get(accountId);
 *   // ... повторить
 * }
 * ```
 */
import { TradingError } from '@polymarket/errors';

export class VersionConflictError extends TradingError {
  public readonly severity = 'low' as const;

  /**
   * Создаёт VersionConflictError.
   *
   * @param accountId - ID аккаунта с конфликтом
   * @param expected - Ожидаемая версия (прочитанная при get())
   * @param actual - Фактическая версия в store
   */
  constructor(accountId: string, expected: number, actual: number) {
    super(
      `Portfolio version conflict for ${accountId}: expected ${expected}, got ${actual}`,
    );
  }
}
