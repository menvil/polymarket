/**
 * InvalidTimestampError - ошибка валидации временной метки
 *
 * @remarks
 * Выбрасывается когда временная метка имеет некорректное значение:
 * - Отрицательное значение (< 0)
 * - NaN или не число
 * - Infinity или -Infinity (не finite)
 * - Не целое число (дробная часть)
 * - Выход за допустимые границы (> 9999999999999)
 * - Некорректный формат при парсинге
 *
 * Используется в value object Timestamp при создании и валидации.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidTimestampError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidTimestampError('Timestamp cannot be negative');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new InvalidTimestampError('Invalid timestamp', {
 *   code: InvalidTimestampError.code,
 *   context: { value: -1, reason: 'NOT_POSITIVE' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidTimestampError(
 *   (ctx) => `Invalid timestamp: ${ctx.reason}`,
 *   {
 *     code: InvalidTimestampError.code,
 *     context: { value: NaN, reason: 'NOT_FINITE' }
 *   }
 * );
 * // "Invalid timestamp: NOT_FINITE"
 *
 * // С условной логикой в template
 * throw new InvalidTimestampError(
 *   (ctx) => ctx.reason === 'NOT_INTEGER'
 *     ? `Timestamp must be an integer, got: ${ctx.value}`
 *     : `Timestamp must be within valid range`,
 *   {
 *     code: InvalidTimestampError.code,
 *     context: { value: 123.456, reason: 'NOT_INTEGER' }
 *   }
 * );
 * ```
 */
import { TradingError } from '../base/index.js';
/**
 * InvalidTimestampError - ошибка валидации временной метки
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_TIMESTAMP
 */
export class InvalidTimestampError extends TradingError {
    severity = 'low';
    /**
     * Рекомендуемый код ошибки
     */
    static code = 'INVALID_TIMESTAMP';
}
//# sourceMappingURL=InvalidTimestampError.js.map