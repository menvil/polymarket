import { type Result } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import Decimal from 'decimal.js';
/**
 * Валидация: ширина спреда должна быть <= максимума
 *
 * @remarks
 * Atomic business rule для проверки максимальной ширины спреда.
 *
 * **Применение:**
 * - Обнаружение неликвидных рынков
 * - Предупреждение о широких спредах
 * - Risk management
 *
 * @example
 * ```typescript
 * const width = new Decimal(0.05);
 * const maxWidth = new Decimal(0.10);
 * const result = ValidateMaxWidth.check(width, maxWidth);
 * // result.ok === true
 * ```
 */
export declare class ValidateMaxWidth {
    /**
     * Проверить что ширина <= максимума
     *
     * @param width - Ширина спреда
     * @param maxWidth - Максимальная допустимая ширина
     * @returns Ok если <= максимума, Err если больше
     */
    static check(width: Decimal, maxWidth: Decimal): Result<void, InvalidSpreadError>;
}
//# sourceMappingURL=ValidateMaxWidth.d.ts.map