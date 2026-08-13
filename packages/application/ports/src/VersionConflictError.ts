/**
 * Ошибка конфликта версий при CAS-сохранении/удалении.
 *
 * @remarks
 * Возвращается (НЕ выбрасывается) как `Err(VersionConflictError)` из
 * CAS-методов портов, когда версия в store не совпадает с ожидаемой:
 * - `IPortfolioStore.save()` — `resourceId` = accountId
 * - `IOrderRepository.save()` / `deleteIfVersion()` — `resourceId` = orderId
 *
 * Caller должен перечитать актуальное состояние и решить: повторить операцию,
 * деградировать в no-op или вернуть ошибку.
 *
 * `resourceId`/`expected`/`actual` доступны как типизированные поля
 * (не только в тексте `message`) — для structured logging, метрик и retry-логики.
 *
 * @example
 * ```typescript
 * const result = store.save(portfolio, expectedVersion);
 * if (!result.ok && result.error instanceof VersionConflictError) {
 *   logger.warn('CAS conflict', {
 *     resourceId: result.error.resourceId,
 *     expected: result.error.expected,
 *     actual: result.error.actual,
 *   });
 *   // Retry: перечитать состояние и повторить операцию
 *   const fresh = store.get(accountId);
 *   // ... повторить
 * }
 * ```
 */
import { TradingError } from '@polymarket/errors';

/** Ошибка CAS-конфликта версий — см. описание модуля выше. */
export class VersionConflictError extends TradingError {
  public readonly severity = 'low' as const;

  /**
   * @param resourceId - ID ресурса с конфликтом (accountId для Portfolio, orderId для Order)
   * @param expected - Ожидаемая версия (прочитанная при get()/getVersion())
   * @param actual - Фактическая версия в store
   */
  constructor(
    public readonly resourceId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Version conflict for ${resourceId}: expected ${expected}, got ${actual}`,
      { context: { resourceId, expected, actual } },
    );
  }
}
