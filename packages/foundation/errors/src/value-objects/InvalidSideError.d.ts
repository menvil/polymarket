/**
 * InvalidSideError - ошибка валидации стороны сделки
 *
 * @remarks
 * Выбрасывается когда сторона сделки имеет некорректное значение:
 * - Не 'BUY' и не 'SELL'
 * - Неправильный регистр ('buy', 'Buy', 'BUYING')
 * - Пустая строка или null/undefined
 * - Некорректный формат
 *
 * Используется в value object Side при создании и валидации.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidSideError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidSideError('Side must be BUY or SELL');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new InvalidSideError('Invalid side value', {
 *   code: InvalidSideError.code,
 *   context: { value: 'UNKNOWN', reason: 'INVALID_VALUE' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidSideError(
 *   (ctx) => `Invalid side: "${ctx.value}". Expected BUY or SELL`,
 *   {
 *     code: InvalidSideError.code,
 *     context: { value: 'buy', reason: 'INVALID_VALUE' }
 *   }
 * );
 * // "Invalid side: "buy". Expected BUY or SELL"
 *
 * // С условной логикой в template
 * throw new InvalidSideError(
 *   (ctx) => ctx.value === ''
 *     ? 'Side cannot be empty'
 *     : `Invalid side value: "${ctx.value}"`,
 *   {
 *     code: InvalidSideError.code,
 *     context: { value: '', reason: 'EMPTY' }
 *   }
 * );
 * ```
 */
import { TradingError, ErrorSeverity } from '../base/index.js';
/**
 * InvalidSideError - ошибка валидации стороны сделки
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_SIDE
 */
export declare class InvalidSideError extends TradingError {
    readonly severity: ErrorSeverity;
    /**
     * Рекомендуемый код ошибки
     */
    static readonly code = "INVALID_SIDE";
}
//# sourceMappingURL=InvalidSideError.d.ts.map