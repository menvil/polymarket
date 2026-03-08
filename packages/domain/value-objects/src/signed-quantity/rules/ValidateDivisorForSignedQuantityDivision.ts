import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError, ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';

/**
 * Правило: Делитель для операции деления SignedQuantity должен быть ненулевым и finite
 *
 * @remarks
 * Policy конкретной операции деления SignedQuantity.
 *
 * В отличие от ValidateDivisorForQuantityDivision, допускает отрицательные делители:
 * SignedQuantity поддерживает отрицательные значения, поэтому деление на отрицательный
 * делитель является валидной операцией (меняет знак результата).
 *
 * Проверяет:
 * - divisor isFinite (исключает NaN, Infinity, -Infinity)
 * - divisor !== 0 (деление на ноль недопустимо)
 *
 * @param divisor - Делитель для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidSignedQuantityError>
 *
 * @example
 * ```typescript
 * // Положительный делитель — Ok
 * ValidateDivisorForSignedQuantityDivision.check(new Decimal(2));   // Ok
 *
 * // Отрицательный делитель — Ok (допускается для SignedQuantity)
 * ValidateDivisorForSignedQuantityDivision.check(new Decimal(-2));  // Ok
 *
 * // Ноль — Err(DIVISION_BY_ZERO)
 * ValidateDivisorForSignedQuantityDivision.check(new Decimal(0));   // Err
 *
 * // Infinity — Err(NON_FINITE)
 * ValidateDivisorForSignedQuantityDivision.check(new Decimal(Infinity)); // Err
 * ```
 */
export class ValidateDivisorForSignedQuantityDivision {
  public static check(divisor: Decimal): Result<void, InvalidSignedQuantityError> {
    // Проверка 1: делитель должен быть finite (исключает NaN, Infinity, -Infinity)
    if (!divisor.isFinite()) {
      return Err(
        new InvalidSignedQuantityError(
          (ctx) => `Divisor for SignedQuantity division must be finite, got ${ctx.divisor}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: SignedQuantityErrorReason.NON_FINITE,
              divisor: divisor.toString()
            }
          }
        )
      );
    }

    // Проверка 2: делитель не должен быть нулём
    if (divisor.isZero()) {
      return Err(
        new InvalidSignedQuantityError(
          (ctx) => `Cannot divide SignedQuantity by zero, got divisor ${ctx.divisor}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: SignedQuantityErrorReason.DIVISION_BY_ZERO,
              divisor: divisor.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
