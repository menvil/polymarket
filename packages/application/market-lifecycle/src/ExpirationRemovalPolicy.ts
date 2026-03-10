/**
 * ExpirationRemovalPolicy — политика удаления рынков по истечению срока.
 *
 * @remarks
 * Закрывает рынки, до истечения которых осталось меньше `leadTimeMs` миллисекунд.
 * Это даёт время отменить открытые ордера и выйти из позиций до финальных торгов.
 *
 * ### Параметры по умолчанию:
 * - `leadTimeMs = 30 * 60 * 1000` (30 минут)
 *
 * ### Алгоритм:
 * ```
 * nowMs = clock.now().getTime()
 * for market in markets:
 *   timeToExpiry = market.expiresAt.toNumber() - nowMs
 *   if timeToExpiry <= leadTimeMs → закрыть рынок
 * ```
 *
 * @example
 * ```typescript
 * const policy = new ExpirationRemovalPolicy(new LiveClock(), 30 * 60 * 1000);
 *
 * const toClose = policy.evaluate(activeMarkets);
 * // toClose = рынки истекающие в течение 30 минут
 * ```
 */
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
   */
  constructor(
    private readonly _clock: IClock,
    private readonly _leadTimeMs = DEFAULT_LEAD_TIME_MS,
  ) {}

  /**
   * Определяет рынки для закрытия по критерию истечения срока.
   *
   * @param markets - Список активных рынков
   * @returns ID рынков, до истечения которых осталось меньше leadTimeMs
   *
   * @remarks
   * Рынки с уже истёкшим expiresAt (timeToExpiry < 0) также включаются.
   */
  public evaluate(markets: readonly MarketContext[]): readonly MarketId[] {
    const nowMs = this._clock.now().getTime();

    return markets
      .filter((market) => {
        const timeToExpiry = market.expiresAt.toNumber() - nowMs;
        return timeToExpiry <= this._leadTimeMs;
      })
      .map((market) => market.marketId);
  }
}
