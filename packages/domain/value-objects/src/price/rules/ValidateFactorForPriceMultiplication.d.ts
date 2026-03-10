import { Result } from '@polymarket/result';
import { InvalidOperandError } from '@polymarket/errors';
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
 * - factor не отрицательный (умножение на отрицательный множитель нарушит смысл цены)
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
export declare class ValidateFactorForPriceMultiplication {
    static check(factor: Decimal): Result<void, InvalidOperandError>;
}
//# sourceMappingURL=ValidateFactorForPriceMultiplication.d.ts.map