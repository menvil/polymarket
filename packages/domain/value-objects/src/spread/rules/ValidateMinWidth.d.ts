import { type Result } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import Decimal from 'decimal.js';
/**
 * Валидация: ширина спреда должна быть >= минимума
 *
 * @remarks
 * Atomic business rule для проверки минимальной ширины спреда.
 *
 * **Применение:**
 * - Обеспечение минимальной ликвидности
 * - Предотвращение слишком узких спредов
 * - Market-making rules
 *
 * @example
 * ```typescript
 * const width = new Decimal(0.01);
 * const minWidth = new Decimal(0.005);
 * const result = ValidateMinWidth.check(width, minWidth);
 * // result.ok === true
 * ```
 */
export declare class ValidateMinWidth {
    /**
     * Проверить что ширина >= минимума
     *
     * @param width - Ширина спреда
     * @param minWidth - Минимальная допустимая ширина
     * @returns Ok если >= минимума, Err если меньше
     */
    static check(width: Decimal, minWidth: Decimal): Result<void, InvalidSpreadError>;
}
//# sourceMappingURL=ValidateMinWidth.d.ts.map