import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { QuoteErrorReason } from '../errors/QuoteErrorReason.js';
import { ErrorSource } from '../../shared/facade/ErrorSource.js';

/**
 * Проверяет минимальную ширину спреда
 *
 * @remarks
 * Используется для предотвращения too tight spreads.
 *
 * Это бизнес-правило для market making:
 * - Слишком узкий spread может указывать на ошибку
 * - Или на манипуляцию рынком
 * - Минимальный spread зависит от рынка и волатильности
 *
 * @example
 * ```typescript
 * const spread = new Decimal(0.0005); // 0.05%
 * const minSpread = new Decimal(0.001); // 0.1%
 *
 * const result = ValidateMinSpread.check(spread, minSpread);
 * // result.ok === false
 * // spread меньше минимального
 * ```
 */
export class ValidateMinSpread {
  /**
   * Проверяет минимальный spread
   *
   * @param spread - Ширина спреда
   * @param minSpread - Минимально допустимый spread
   * @returns Result с void или InvalidQuoteError
   *
   * @example
   * ```typescript
   * const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());
   * const spread = quote.spreadWidth();
   *
   * if (spread !== null) {
   *   const result = ValidateMinSpread.check(spread, new Decimal(0.001));
   *   if (!result.ok) {
   *     console.error('Spread too narrow');
   *   }
   * }
   * ```
   */
  public static check(
    spread: Decimal,
    minSpread: Decimal
  ): Result<void, InvalidQuoteError> {
    if (spread.lessThan(minSpread)) {
      return Err(
        new InvalidQuoteError(`Spread ${spread} is below minimum ${minSpread}`, {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            reason: QuoteErrorReason.SPREAD_TOO_NARROW,
            spread: spread.toNumber(),
            minSpread: minSpread.toNumber()
          }
        })
      );
    }

    return Ok(undefined);
  }
}
