/**
 * Ошибка конфликта версий Portfolio при CAS-сохранении.
 *
 * @remarks
 * Возвращается (НЕ выбрасывается) как `Err(VersionConflictError)` из
 * `IPortfolioStore.save()`, когда версия в store не совпадает с ожидаемой.
 * Caller должен перечитать Portfolio и повторить.
 *
 * `accountId`/`expected`/`actual` доступны как типизированные поля
 * (не только в тексте `message`) — для structured logging, метрик и retry-логики.
 *
 * @example
 * ```typescript
 * const result = store.save(portfolio, expectedVersion);
 * if (!result.ok && result.error instanceof VersionConflictError) {
 *   logger.warn('CAS conflict', {
 *     accountId: result.error.accountId,
 *     expected: result.error.expected,
 *     actual: result.error.actual,
 *   });
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
   * @param accountId - ID аккаунта с конфликтом
   * @param expected - Ожидаемая версия (прочитанная при get())
   * @param actual - Фактическая версия в store
   */
  constructor(
    public readonly accountId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Portfolio version conflict for ${accountId}: expected ${expected}, got ${actual}`,
      { context: { accountId, expected, actual } },
    );
  }
}
