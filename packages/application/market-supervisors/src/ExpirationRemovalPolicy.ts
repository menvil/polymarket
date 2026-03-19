/**
 * ExpirationRemovalPolicy — политика удаления рынков по истечению срока.
 *
 * @remarks
 * Закрывает рынки, до истечения которых осталось меньше `leadTimeMs` миллисекунд.
 * Это даёт стратегии время завершить торговлю до финальных торгов.
 *
 * ### Параметры по умолчанию:
 * - `leadTimeMs = 30 * 60 * 1000` (30 минут)
 *
 * ### Алгоритм:
 * ```
 * deadline = now + leadTimeMs
 * for market in markets:
 *   if market.expiresAt <= deadline → закрыть рынок
 * ```
 *
 * @example
 * ```typescript
 * const policy = new ExpirationRemovalPolicy(new LiveClock(), 30 * 60 * 1000);
 *
 * const toClose = policy.evaluate(activeMarkets);
 * // toClose = рынки, истекающие в течение 30 минут
 * ```
 */
import { TimestampService } from '@polymarket/value-objects';
import type { IClock } from '@polymarket/time';
import type { MarketId } from '@polymarket/ids';
import type { IRemovalPolicy, MarketContext } from './IRemovalPolicy.js';

/** Время опережения закрытия рынка (30 минут в мс) по умолчанию */
const DEFAULT_LEAD_TIME_MS = 30 * 60 * 1000;

/**
 * Политика удаления истекающих рынков.
 *
 * @remarks
 * Закрывает рынки за `leadTimeMs` до истечения срока их действия.
 */
export class ExpirationRemovalPolicy implements IRemovalPolicy {
  /**
   * @param _clock - Источник времени (dependency injection)
   * @param _leadTimeMs - За сколько мс до истечения закрывать рынок (по умолчанию 30 мин)
   *
   * @throws {RangeError} Если `leadTimeMs` отрицательный
   */
  constructor(
    private readonly _clock: IClock,
    private readonly _leadTimeMs = DEFAULT_LEAD_TIME_MS,
  ) {
    if (_leadTimeMs < 0) {
      throw new RangeError(
        `ExpirationRemovalPolicy: leadTimeMs must be >= 0, got ${_leadTimeMs}`,
      );
    }
  }

  /**
   * Определяет рынки для закрытия по критерию истечения срока.
   *
   * @param markets - Список активных рынков
   * @returns ID рынков, до истечения которых осталось не более `leadTimeMs`
   *
   * @remarks
   * Рынки с уже истёкшим `expiresAt` также включаются.
   * Если `TimestampService.create(deadline)` не удался — возвращает пустой список (fail-safe).
   */
  public evaluate(markets: readonly MarketContext[]): readonly MarketId[] {
    const nowMs = this._clock.now().getTime();
    const deadlineResult = TimestampService.create(nowMs + this._leadTimeMs);

    if (!deadlineResult.ok) return [];

    const deadline = deadlineResult.value;

    return markets
      .filter((market) => market.expiresAt.isBeforeOrEqual(deadline))
      .map((market) => market.marketId);
  }
}
