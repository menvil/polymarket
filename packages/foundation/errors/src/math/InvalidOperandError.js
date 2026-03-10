import { TradingError } from '../base/index.js';
/**
 * InvalidOperandError - ошибка невалидного операнда
 *
 * @remarks
 * Выбрасывается при попытке арифметической операции с невалидным значением (NaN, Infinity).
 * Это математическая невозможность, а не бизнес-правило.
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 * Рекомендуемый код ошибки: INVALID_OPERAND
 *
 * @example
 * ```typescript
 * import { InvalidOperandError } from '@polymarket/errors';
 *
 * // С динамическим сообщением
 * throw new InvalidOperandError(
 *   (ctx) => `Operand 'a' must be finite, got ${ctx.a}`,
 *   {
 *     context: { a: 'NaN', b: '100', operation: 'add' }
 *   }
 * );
 *
 * // Статическое сообщение
 * throw new InvalidOperandError('Invalid operand', {
 *   context: { operand: 'Infinity', operation: 'multiply' }
 * });
 * ```
 */
export class InvalidOperandError extends TradingError {
    severity = 'low';
    /**
     * Рекомендуемый код ошибки
     */
    static code = 'INVALID_OPERAND';
}
//# sourceMappingURL=InvalidOperandError.js.map