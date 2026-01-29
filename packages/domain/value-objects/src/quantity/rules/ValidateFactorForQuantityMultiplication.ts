import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Правило: Factor для операции умножения Quantity должен быть неотрицательным и finite
 *
 * @remarks
 * Policy конкретной операции умножения Quantity.
 *
 * Проверяет:
 * - factor >= 0 (иначе результат может стать отрицательным, нарушит инвариант)
 * - factor isFinite (иначе результат может стать infinite/NaN, нарушит инвариант)
 *
 * Возвращает InvalidQuantityError — стандарт домена Polymarket для валидации Quantity.
 *
 * @param factor - Factor для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidQuantityError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateFactorForQuantityMultiplication.check(new Decimal(2));
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { factor }
 * }
 * ```
 */
export class ValidateFactorForQuantityMultiplication {
  public static check(factor: Decimal): Result<void, InvalidQuantityError> {
    // Проверка 1: factor должен быть finite (включая -Infinity)
    if (!factor.isFinite()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Factor for Quantity multiplication must be finite, got ${ctx.factor}`,
          {
            context: { factor: factor.toString() }
          }
        )
      );
    }

    // Проверка 2: factor не должен быть отрицательным
    if (factor.isNegative()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Factor for Quantity multiplication cannot be negative, got ${ctx.factor}`,
          {
            context: { factor: factor.toString() }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
