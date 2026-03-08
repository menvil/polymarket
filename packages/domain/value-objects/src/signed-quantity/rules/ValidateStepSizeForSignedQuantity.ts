import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError, ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';

/**
 * Правило: StepSize для округления SignedQuantity должен быть положительным и finite
 *
 * @remarks
 * Правило для операции roundToStep SignedQuantity.
 *
 * Проверяет:
 * - stepSize > 0 (stepSize <= 0 не имеет смысла для округления)
 * - stepSize isFinite
 *
 * Возвращает InvalidSignedQuantityError с reason для дифференциации ошибок.
 *
 * @param stepSize - StepSize для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidSignedQuantityError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateStepSizeForSignedQuantity.check(new Decimal(0.01));
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { stepSize, reason }
 * }
 * ```
 */
export class ValidateStepSizeForSignedQuantity {
  public static check(stepSize: Decimal): Result<void, InvalidSignedQuantityError> {
    // Проверка 1: stepSize должен быть finite (проверяем первым)
    if (!stepSize.isFinite()) {
      return Err(
        new InvalidSignedQuantityError(
          (ctx) => `Step size for SignedQuantity must be finite, got ${ctx.stepSize}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: SignedQuantityErrorReason.NON_FINITE,
              stepSize: stepSize.toString()
            }
          }
        )
      );
    }

    // Проверка 2: stepSize должен быть positive
    if (stepSize.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidSignedQuantityError(
          (ctx) => `Step size for SignedQuantity must be positive, got ${ctx.stepSize}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: SignedQuantityErrorReason.NON_POSITIVE_STEP_SIZE,
              stepSize: stepSize.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
