import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError, ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';

/**
 * Правило: Factor для операции multiply SignedQuantity должен быть finite
 *
 * @remarks
 * Policy конкретной операции умножения SignedQuantity.
 *
 * В отличие от ValidateFactorForQuantityMultiplication (требует factor >= 0),
 * допускает отрицательные и нулевые факторы:
 * - Отрицательный factor инвертирует знак (100 * -1 = -100) — допустимо для SignedQuantity
 * - Нулевой factor даёт ноль — допустимо
 * - Не-finite (NaN, Infinity) — недопустимо: нарушит инвариант SignedQuantity
 *
 * Проверяет:
 * - factor isFinite (исключает NaN, Infinity, -Infinity)
 *
 * @param factor - Factor для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidSignedQuantityError>
 *
 * @example
 * ```typescript
 * // Положительный factor — Ok
 * ValidateFactorForSignedQuantityMultiplication.check(new Decimal(2));    // Ok
 *
 * // Отрицательный factor — Ok (инверсия знака, допустимо для SignedQuantity)
 * ValidateFactorForSignedQuantityMultiplication.check(new Decimal(-1));   // Ok
 *
 * // Нулевой factor — Ok (результат = 0)
 * ValidateFactorForSignedQuantityMultiplication.check(new Decimal(0));    // Ok
 *
 * // Infinity — Err(NON_FINITE)
 * ValidateFactorForSignedQuantityMultiplication.check(new Decimal(Infinity)); // Err
 * ```
 */
export class ValidateFactorForSignedQuantityMultiplication {
  public static check(factor: Decimal): Result<void, InvalidSignedQuantityError> {
    // Проверка: factor должен быть finite (исключает NaN, Infinity, -Infinity)
    if (!factor.isFinite()) {
      return Err(
        new InvalidSignedQuantityError(
          (ctx) => `Factor for SignedQuantity multiplication must be finite, got ${ctx.factor}`,
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

    return Ok(undefined);
  }
}
