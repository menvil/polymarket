import { Result, Ok, Err } from '@polymarket/result';
import { InvalidDivisorError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Правило: Делитель для операции деления Price должен быть валидным
 *
 * @remarks
 * Policy конкретной операции деления Price.
 *
 * Проверяет:
 * - divisor не NaN (иначе результат станет NaN, нарушит инвариант)
 * - divisor isFinite (иначе результат может стать 0 или NaN)
 * - divisor не ноль (деление на ноль невозможно)
 *
 * Возвращает InvalidDivisorError для семантической точности.
 *
 * @param divisor - Делитель для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidDivisorError>
 *
 * @example
 * ```typescript
 * // ✅ Валидный делитель
 * const result1 = ValidateDivisorForPriceDivision.check(new Decimal(2));
 * // result1.ok === true
 *
 * // ❌ Деление на ноль
 * const result2 = ValidateDivisorForPriceDivision.check(new Decimal(0));
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason); // 'is_zero'
 * }
 *
 * // ❌ NaN делитель
 * const result3 = ValidateDivisorForPriceDivision.check(new Decimal(NaN));
 * if (!result3.ok) {
 *   console.error(result3.error.context?.reason); // 'is_nan'
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
            context: {
              divisor: divisor.toString(),
              reason: 'not_finite'
            }
          }
        )
      );
    }

    // Проверка 3: divisor не должен быть 0
    if (divisor.isZero()) {
      return Err(
        new InvalidDivisorError(
          () => `Divisor cannot be zero`,
          {
            context: {
              divisor: divisor.toString(),
              reason: 'is_zero'
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
