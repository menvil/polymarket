import { Result, Ok, Err } from '@polymarket/result';
import { InvalidDivisorError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Правило: Делитель для операции деления Price должен быть finite и не NaN
 *
 * @remarks
 * Policy конкретной операции деления Price.
 *
 * Проверяет:
 * - divisor не NaN (иначе результат станет NaN, нарушит инвариант)
 * - divisor isFinite (иначе результат может стать 0 или NaN)
 *
 * НЕ проверяет деление на ноль - это отдельная ответственность PriceService.
 *
 * Возвращает InvalidDivisorError для семантической точности.
 *
 * @param divisor - Делитель для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidDivisorError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateDivisorForPriceDivision.check(new Decimal(2));
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { divisor, reason }
 * }
 * ```
 */
export class ValidateDivisorForPriceDivision {
  public static check(divisor: Decimal): Result<void, InvalidDivisorError> {
    // Проверка 1: divisor не должен быть NaN
    if (divisor.isNaN()) {
      return Err(
        new InvalidDivisorError(
          () => `Divisor cannot be NaN`,
          {
            code: InvalidDivisorError.code,
            context: {
              divisor: divisor.toString(),
              reason: 'is_nan'
            }
          }
        )
      );
    }

    // Проверка 2: divisor должен быть finite (исключает Infinity, -Infinity)
    if (!divisor.isFinite()) {
      return Err(
        new InvalidDivisorError(
          () => `Divisor must be finite`,
          {
            code: InvalidDivisorError.code,
            context: {
              divisor: divisor.toString(),
              reason: 'not_finite'
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
