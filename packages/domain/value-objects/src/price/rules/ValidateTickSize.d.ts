import { Result } from '@polymarket/result';
import { InvalidTickSizeError } from '@polymarket/errors';
import Decimal from 'decimal.js';
/**
 * Правило: TickSize должен быть валидным для Price
 *
 * @remarks
 * Проверяет базовые свойства tickSize:
 * - Не NaN
 * - Положительный
 * - Конечный
 * - Не больше чем диапазон (MAX - MIN)
 *
 * НЕ проверяет кратность базовому тику - используй ValidateTickSizeMultipleOfBaseTick.
 *
 * @example
 * ```typescript
 * import { ValidateTickSize } from '@polymarket/value-objects/price';
 * import Decimal from 'decimal.js';
 *
 * const result = ValidateTickSize.check(new Decimal(0.0001));
 * if (result.ok) {
 *   const tickDecimal = result.value; // Decimal
 * } else {
 *   console.error(result.error.context.reason); // 'is_nan' | ...
 * }
 * ```
 */
export declare class ValidateTickSize {
    /**
     * Проверяет валидность tickSize
     *
     * @param tickSize - Размер тика (уже Decimal - парсинг делается в Facade)
     * @returns Result с валидированным Decimal или InvalidTickSizeError
     *
     * @remarks
     * ВАЖНО: Принимает только Decimal. Парсинг должен быть сделан в Facade через toDecimal().
     * Rule НЕ должна парсить - это ответственность Facade.
     *
     * @example
     * ```typescript
     * const tickDecimal = new Decimal('0.0001');
     * const result = ValidateTickSize.check(tickDecimal);
     * if (!result.ok) {
     *   console.error(result.error.context.field); // 'tickSize'
     *   console.error(result.error.context.reason); // 'is_nan' | ...
     *   return;
     * }
     * const validated = result.value; // Используем в дальнейшем
     * ```
     */
    static check(tickSize: Decimal): Result<Decimal, InvalidTickSizeError>;
}
//# sourceMappingURL=ValidateTickSize.d.ts.map