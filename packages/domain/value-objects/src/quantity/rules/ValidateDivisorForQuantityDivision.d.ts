import { Result } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';
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
export declare class ValidateDivisorForQuantityDivision {
    static check(divisor: Decimal): Result<void, InvalidQuantityError>;
}
//# sourceMappingURL=ValidateDivisorForQuantityDivision.d.ts.map