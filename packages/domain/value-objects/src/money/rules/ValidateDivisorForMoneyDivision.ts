import { Result, Ok, Err } from '@polymarket/result';
import { InvalidMoneyError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Правило: Делитель для операции деления Money должен быть валидным
 *
 * @remarks
 * Policy конкретной операции деления Money.
 *
 * Проверяет:
 * - divisor не NaN (иначе результат станет NaN, нарушит инвариант)
 * - divisor isFinite (иначе результат может стать 0 или NaN)
 * - divisor не ноль (деление на ноль невозможно)
 *
 * Возвращает InvalidMoneyError — стандарт домена Polymarket для валидации Money.
 *
 * @param divisor - Делитель для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidMoneyError>
 *
 * @example
 * ```typescript
 * // ✅ Валидный делитель
 * const result1 = ValidateDivisorForMoneyDivision.check(new Decimal(2));
 * // result1.ok === true
 *
 * // ❌ Деление на ноль
 * const result2 = ValidateDivisorForMoneyDivision.check(new Decimal(0));
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason); // 'DIVISION_BY_ZERO'
 * }
 *
 * // ❌ NaN делитель
 * const result3 = ValidateDivisorForMoneyDivision.check(new Decimal(NaN));
 * if (!result3.ok) {
 *   console.error(result3.error.context?.reason); // 'NAN'
 * }
 * ```
 */
export class ValidateDivisorForMoneyDivision {
  public static check(divisor: Decimal): Result<void, InvalidMoneyError> {
    // Проверка 1: divisor не должен быть NaN
    if (divisor.isNaN()) {
      return Err(
        new InvalidMoneyError('Divisor cannot be NaN', {
          context: {
            divisor: divisor.toString(),
            reason: 'NAN'
          }
        })
      );
    }

    // Проверка 2: divisor должен быть finite (исключает Infinity, -Infinity)
    if (!divisor.isFinite()) {
      return Err(
        new InvalidMoneyError('Divisor must be finite', {
          context: {
            divisor: divisor.toString(),
            reason: 'NON_FINITE'
          }
        })
      );
    }

    // Проверка 3: divisor не должен быть 0
    if (divisor.isZero()) {
      return Err(
        new InvalidMoneyError('Cannot divide by zero', {
          context: {
            divisor: divisor.toString(),
            reason: 'DIVISION_BY_ZERO'
          }
        })
      );
    }

    return Ok(undefined);
  }
}
