import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { ErrorSource } from '../../shared/facade/ErrorSource.js';

/**
 * Правило: Делитель для операции деления Quantity должен быть положительным и finite
 *
 * @remarks
 * Policy конкретной операции деления Quantity.
 *
 * Математически можно делить на отрицательное,
 * но в контексте Quantity это нарушит инвариант (результат может стать отрицательным).
 *
 * Проверяет:
 * - divisor > 0
 * - divisor isFinite
 *
 * Возвращает InvalidQuantityError — стандарт домена Polymarket для валидации Quantity.
 *
 * @param divisor - Делитель для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidQuantityError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateDivisorForQuantityDivision.check(new Decimal(2));
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { divisor }
 * }
 * ```
 */
export class ValidateDivisorForQuantityDivision {
  public static check(divisor: Decimal): Result<void, InvalidQuantityError> {
    if (divisor.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Divisor for Quantity division must be positive, got ${ctx.divisor}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              divisor: divisor.toString()
            }
          }
        )
      );
    }

    if (!divisor.isFinite()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Divisor for Quantity division must be finite, got ${ctx.divisor}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              divisor: divisor.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
