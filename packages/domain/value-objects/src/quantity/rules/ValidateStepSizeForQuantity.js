import { Ok, Err } from '@polymarket/result';
import { InvalidQuantityError, ErrorSource } from '@polymarket/errors';
/**
 * Правило: StepSize для округления Quantity должен быть положительным и finite
 *
 * @remarks
 * Правило для операции округления Quantity к шагу (step).
 *
 * Проверяет:
 * - stepSize > 0 (stepSize <= 0 не имеет смысла для округления)
 * - stepSize isFinite
 *
 * Возвращает InvalidQuantityError — стандарт домена Polymarket для валидации Quantity.
 *
 * @param stepSize - StepSize для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidQuantityError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateStepSizeForQuantity.check(new Decimal(0.01));
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { stepSize }
 * }
 * ```
 */
export class ValidateStepSizeForQuantity {
    static check(stepSize) {
        // Проверка 1: stepSize должен быть finite (проверяем первым)
        if (!stepSize.isFinite()) {
            return Err(new InvalidQuantityError((ctx) => `Step size must be finite, got ${ctx.stepSize}`, {
                context: {
                    source: ErrorSource.RULE_VALIDATION,
                    stepSize: stepSize.toString()
                }
            }));
        }
        // Проверка 2: stepSize должен быть positive
        if (stepSize.lessThanOrEqualTo(0)) {
            return Err(new InvalidQuantityError((ctx) => `Step size must be positive, got ${ctx.stepSize}`, {
                context: {
                    source: ErrorSource.RULE_VALIDATION,
                    stepSize: stepSize.toString()
                }
            }));
        }
        return Ok(undefined);
    }
}
//# sourceMappingURL=ValidateStepSizeForQuantity.js.map