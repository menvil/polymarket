/**
 * Rule: Ratio >= -1 (для операций типа "1 + ratio")
 *
 * @remarks
 * Проверяет, что ratio >= -1, что гарантирует (1 + ratio) >= 0
 * Используется для операций:
 * - Money.addRate(ratio): amount * (1 + ratio)
 * - Price.applyMarkup(ratio): price * (1 + ratio)
 *
 * @example
 * ```typescript
 * // ✅ Valid: -1 <= ratio
 * ValidateRatioGteMinusOne.check(new Decimal(-1), 'addRate');
 * ValidateRatioGteMinusOne.check(new Decimal(-0.5), 'addRate'); // -50% discount
 * ValidateRatioGteMinusOne.check(new Decimal(0.1), 'addRate'); // +10% markup
 *
 * // ❌ Invalid: ratio < -1
 * ValidateRatioGteMinusOne.check(new Decimal(-1.5), 'addRate');
 * // => Err(InvalidRatioError with reason LESS_THAN_MINUS_ONE)
 * ```
 */
import Decimal from 'decimal.js';
import { Result } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
export declare class ValidateRatioGteMinusOne {
    /**
     * Проверить, что ratio >= -1
     *
     * @param value - Значение ratio для проверки
     * @param operation - Название операции (для контекста ошибки)
     * @returns Ok(undefined) если valid, Err(InvalidRatioError) если invalid
     */
    static check(value: Decimal, operation: string): Result<void, InvalidRatioError>;
}
//# sourceMappingURL=ValidateRatioGteMinusOne.d.ts.map