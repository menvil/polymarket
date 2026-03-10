import Decimal from 'decimal.js';
import { Result } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
/**
 * Business rule: Ratio должен быть <= 1
 *
 * @remarks
 * Используется для операций типа `amount * (1 - ratio)`, где:
 * - Ratio > 1 приведёт к отрицательному результату
 * - Примеры: discount (скидка), fee (комиссия), slippage
 *
 * @example
 * ```typescript
 * // Discount 10% (0.1)
 * const discountRatio = new Decimal(0.1);
 * const check = ValidateRatioLteOne.check(discountRatio, 'fromPercent');
 * // OK: 0.1 <= 1
 *
 * // Invalid discount 150% (1.5)
 * const invalidDiscount = new Decimal(1.5);
 * const check2 = ValidateRatioLteOne.check(invalidDiscount, 'fromPercent');
 * // Err: 1.5 > 1, invalid для oneMinus()
 * ```
 */
export declare class ValidateRatioLteOne {
    /**
     * Проверить, что ratio <= 1
     *
     * @param value - Значение ratio (как Decimal)
     * @param operation - Название операции (для error context)
     * @returns Result<void, InvalidRatioError>
     */
    static check(value: Decimal, operation: string): Result<void, InvalidRatioError>;
}
//# sourceMappingURL=ValidateRatioLteOne.d.ts.map