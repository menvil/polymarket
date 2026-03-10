/**
 * InvalidQuantityError - ошибка валидации количества акций
 *
 * @remarks
 * Выбрасывается когда количество акций имеет некорректное значение:
 * - Отрицательное количество
 * - Нулевое количество (когда требуется положительное)
 * - NaN или не число
 *
 * Используется в value object Quantity при создании и валидации.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidQuantityError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidQuantityError('Quantity must be positive');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new InvalidQuantityError('Invalid quantity', {
 *   code: InvalidQuantityError.code,
 *   context: { value: -5, min: 0 }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidQuantityError(
 *   (ctx) => `Invalid quantity ${ctx.value}: must be >= ${ctx.min}`,
 *   {
 *     code: InvalidQuantityError.code,
 *     context: { value: -5, min: 0 }
 *   }
 * );
 * // "Invalid quantity -5: must be >= 0"
 *
 * // С условной логикой в template
 * throw new InvalidQuantityError(
 *   (ctx) => ctx.min === 0
 *     ? `Quantity ${ctx.value} must be non-negative`
 *     : `Quantity ${ctx.value} must be >= ${ctx.min}`,
 *   {
 *     code: InvalidQuantityError.code,
 *     context: { value: -1, min: 0 }
 *   }
 * );
 * ```
 */
import { TradingError } from '../base/index.js';
/**
 * InvalidQuantityError - ошибка валидации количества акций
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_QUANTITY
 */
export class InvalidQuantityError extends TradingError {
    severity = 'low';
    /**
     * Рекомендуемый код ошибки
     */
    static code = 'INVALID_QUANTITY';
}
//# sourceMappingURL=InvalidQuantityError.js.map