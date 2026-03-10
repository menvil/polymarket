import { Result } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';
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
export declare class ValidateStepSizeForQuantity {
    static check(stepSize: Decimal): Result<void, InvalidQuantityError>;
}
//# sourceMappingURL=ValidateStepSizeForQuantity.d.ts.map