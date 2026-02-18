import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOperandError, ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Правило: Factor для операции умножения Price должен быть finite и не NaN
 *
 * @remarks
 * Policy конкретной операции умножения Price.
 *
 * Проверяет:
 * - factor не NaN (иначе результат станет NaN, нарушит инвариант)
 * - factor isFinite (иначе результат может стать infinite, нарушит инвариант)
 *
 * Возвращает InvalidOperandError для семантической точности.
 *
 * @param factor - Factor для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidOperandError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateFactorForPriceMultiplication.check(new Decimal(2));
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { operation, operand, reason }
 * }
 * ```
 */
export class ValidateFactorForPriceMultiplication {
  public static check(factor: Decimal): Result<void, InvalidOperandError> {
    // Проверка 1: factor не должен быть отрицательным
    if (factor.isNegative()) {
      return Err(
        new InvalidOperandError(
          () => `Factor cannot be negative`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              operation: 'multiply',
              operand: 'factor',
              value: factor.toString(),
              reason: 'is_negative'
            }
          }
        )
      );
    }

    // Проверка 2: factor не должен быть NaN
    if (factor.isNaN()) {
      return Err(
        new InvalidOperandError(
          () => `Factor cannot be NaN`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              operation: 'multiply',
              operand: 'factor',
              value: factor.toString(),
              reason: 'is_nan'
            }
          }
        )
      );
    }

    // Проверка 3: factor должен быть finite (исключает Infinity, -Infinity)
    if (!factor.isFinite()) {
      return Err(
        new InvalidOperandError(
          () => `Factor must be finite`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              operation: 'multiply',
              operand: 'factor',
              value: factor.toString(),
              reason: 'not_finite'
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
