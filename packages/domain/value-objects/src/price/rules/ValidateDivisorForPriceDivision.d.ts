import { Result } from '@polymarket/result';
import { InvalidDivisorError } from '@polymarket/errors';
import Decimal from 'decimal.js';
/**
 * Правило: Делитель для операции деления Price должен быть валидным
 *
 * @remarks
 * Policy конкретной операции деления Price.
 *
 * Проверяет:
 * - divisor не NaN (иначе результат станет NaN, нарушит инвариант)
 * - divisor isFinite (иначе результат может стать 0 или NaN)
 * - divisor не отрицательный (отрицательный делитель — семантически некорректная операция для Price)
 * - divisor не ноль (деление на ноль невозможно)
 *
 * Возвращает InvalidDivisorError для семантической точности.
 *
 * @param divisor - Делитель для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidDivisorError>
 *
 * @example
 * ```typescript
 * // ✅ Валидный делитель
 * const result1 = ValidateDivisorForPriceDivision.check(new Decimal(2));
 * // result1.ok === true
 *
 * // ❌ Деление на ноль
 * const result2 = ValidateDivisorForPriceDivision.check(new Decimal(0));
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason); // 'is_zero'
 * }
 *
 * // ❌ NaN делитель
 * const result3 = ValidateDivisorForPriceDivision.check(new Decimal(NaN));
 * if (!result3.ok) {
 *   console.error(result3.error.context?.reason); // 'is_nan'
 * }
 * ```
 */
export declare class ValidateDivisorForPriceDivision {
    static check(divisor: Decimal): Result<void, InvalidDivisorError>;
}
//# sourceMappingURL=ValidateDivisorForPriceDivision.d.ts.map