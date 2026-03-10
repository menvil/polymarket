import { Result } from '@polymarket/result';
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
export declare class ValidateFactorForQuantityMultiplication {
    static check(factor: Decimal): Result<void, InvalidQuantityError>;
}
//# sourceMappingURL=ValidateFactorForQuantityMultiplication.d.ts.map