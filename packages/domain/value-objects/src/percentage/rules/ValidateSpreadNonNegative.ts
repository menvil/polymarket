import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import { Percentage } from '../core/Percentage';
import { PercentageErrorReason } from '../errors/PercentageErrorReason';

/**
 * Правило: Spread (спред) должен быть неотрицательным
 *
 * @remarks
 * Policy для валидации спреда в торговых операциях.
 *
 * Проверяет:
 * - spread >= 0% (спред не может быть отрицательным)
 *
 * Возвращает InvalidPercentageError — стандарт домена Polymarket для валидации Percentage.
 *
 * @param spread - Spread для проверки
 * @returns Result<void, InvalidPercentageError>
 *
 * @example
 * ```typescript
 * const validSpread = Percentage.of(0.5);
 * const validateResult = ValidateSpreadNonNegative.check(validSpread);
 * // validateResult.ok === true
 *
 * const negativeSpread = Percentage.of(-0.1);
 * const invalidResult = ValidateSpreadNonNegative.check(negativeSpread);
 * // invalidResult.ok === false, reason: NEGATIVE_SPREAD
 * ```
 */
export class ValidateSpreadNonNegative {
  public static check(spread: Percentage): Result<void, InvalidPercentageError> {
    // Проверка: spread должен быть >= 0
    if (spread.isNegative()) {
      return Err(
        new InvalidPercentageError('Spread cannot be negative', {
          context: {
            spread: spread.value().toString(),
            reason: PercentageErrorReason.NEGATIVE_SPREAD
          }
        })
      );
    }

    return Ok(undefined);
  }
}
