import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import { Percentage } from '../core/Percentage';
import { PercentageErrorReason } from '../core/PercentageErrorReason';

/**
 * Правило: Fee (комиссия) должна быть неотрицательной
 *
 * @remarks
 * Policy для валидации комиссий в торговых операциях.
 *
 * Проверяет:
 * - fee >= 0% (комиссии не могут быть отрицательными)
 *
 * Возвращает InvalidPercentageError — стандарт домена Polymarket для валидации Percentage.
 *
 * @param fee - Fee (комиссия) для проверки
 * @returns Result<void, InvalidPercentageError>
 *
 * @example
 * ```typescript
 * const fee = Percentage.of(1.5);
 * const validateResult = ValidateFeeNonNegative.check(fee);
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { fee, reason }
 * }
 *
 * const negativeFee = Percentage.of(-0.5);
 * const invalidResult = ValidateFeeNonNegative.check(negativeFee);
 * // invalidResult.ok === false, reason: NEGATIVE_FEE
 * ```
 */
export class ValidateFeeNonNegative {
  public static check(fee: Percentage): Result<void, InvalidPercentageError> {
    // Проверка: fee должна быть >= 0
    if (fee.isNegative()) {
      return Err(
        new InvalidPercentageError('Fee cannot be negative', {
          context: {
            fee: fee.value().toString(),
            reason: PercentageErrorReason.NEGATIVE_FEE
          }
        })
      );
    }

    return Ok(undefined);
  }
}
