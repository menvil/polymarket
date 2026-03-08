import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError, ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';

const ZERO = new Decimal(0);

/**
 * Правило: Factor для операции scale SignedQuantity должен быть неотрицательным и finite
 *
 * @remarks
 * Policy для операции масштабирования SignedQuantity.
 *
 * Проверяет:
 * - factor >= 0 (иначе произойдет инверсия знака, что небезопасно для scale)
 * - factor isFinite (иначе результат может стать infinite/NaN, нарушит инвариант)
 *
 * Возвращает InvalidSignedQuantityError с reason для дифференциации ошибок.
 *
 * @param factor - Factor для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidSignedQuantityError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateFactorForSignedQuantityScale.check(new Decimal(2));
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { factor, reason }
 * }
 * ```
 */
export class ValidateFactorForSignedQuantityScale {
  public static check(factor: Decimal): Result<void, InvalidSignedQuantityError> {
    // Проверка 1: factor должен быть finite (исключает NaN, Infinity, -Infinity)
    if (!factor.isFinite()) {
      return Err(
        new InvalidSignedQuantityError(
          (ctx) => `Factor for SignedQuantity scale must be finite, got ${ctx.factor}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: SignedQuantityErrorReason.NON_FINITE,
              factor: factor.toString()
            }
          }
        )
      );
    }

    // Проверка 2: factor не должен быть отрицательным (lessThan исключает -0)
    if (factor.lessThan(ZERO)) {
      return Err(
        new InvalidSignedQuantityError(
          (ctx) => `Factor for SignedQuantity scale cannot be negative, got ${ctx.factor}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: SignedQuantityErrorReason.NEGATIVE_SCALE_FACTOR,
              factor: factor.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
