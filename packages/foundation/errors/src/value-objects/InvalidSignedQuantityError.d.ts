/**
 * InvalidSignedQuantityError - ошибка валидации знакового количества
 *
 * @remarks
 * Выбрасывается когда знаковое количество имеет некорректное значение:
 * - NaN или не число
 * - Infinity или -Infinity (не finite)
 * - Некорректный формат при парсинге
 * - Деление на ноль
 *
 * Используется в value object SignedQuantity при создании и валидации.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidSignedQuantityError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidSignedQuantityError('SignedQuantity cannot be NaN');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new InvalidSignedQuantityError('Invalid signed quantity', {
 *   code: InvalidSignedQuantityError.code,
 *   context: { value: NaN, reason: 'NAN' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidSignedQuantityError(
 *   (ctx) => `Invalid signed quantity: ${ctx.reason}`,
 *   {
 *     code: InvalidSignedQuantityError.code,
 *     context: { value: Infinity, reason: 'NON_FINITE' }
 *   }
 * );
 * // "Invalid signed quantity: NON_FINITE"
 *
 * // С условной логикой в template
 * throw new InvalidSignedQuantityError(
 *   (ctx) => ctx.reason === 'NAN'
 *     ? `SignedQuantity cannot be NaN`
 *     : `SignedQuantity must be finite, got: ${ctx.value}`,
 *   {
 *     code: InvalidSignedQuantityError.code,
 *     context: { value: Infinity, reason: 'NON_FINITE' }
 *   }
 * );
 * ```
 */
import { TradingError, ErrorSeverity } from '../base/index.js';
/**
 * InvalidSignedQuantityError - ошибка валидации знакового количества
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_SIGNED_QUANTITY
 */
export declare class InvalidSignedQuantityError extends TradingError {
    readonly severity: ErrorSeverity;
    /**
     * Рекомендуемый код ошибки
     */
    static readonly code = "INVALID_SIGNED_QUANTITY";
}
//# sourceMappingURL=InvalidSignedQuantityError.d.ts.map