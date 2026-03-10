import { TradingError } from '../base/index.js';
import type { ErrorSeverity } from '../base/index.js';
/**
 * InvalidDivisorError - ошибка невалидного делителя
 *
 * @remarks
 * Выбрасывается при попытке деления на невалидное значение (NaN, Infinity).
 * Это математическая невозможность, а не бизнес-правило.
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 * Рекомендуемый код ошибки: INVALID_DIVISOR
 *
 * @example
 * ```typescript
 * import { InvalidDivisorError } from '@polymarket/errors';
 *
 * // С динамическим сообщением
 * throw new InvalidDivisorError(
 *   (ctx) => `Divisor must be finite, got ${ctx.divisor}`,
 *   {
 *     context: { divisor: 'Infinity', dividend: '100' }
 *   }
 * );
 *
 * // Статическое сообщение
 * throw new InvalidDivisorError('Invalid divisor', {
 *   context: { divisor: NaN }
 * });
 * ```
 */
export declare class InvalidDivisorError extends TradingError {
    readonly severity: ErrorSeverity;
    /**
     * Рекомендуемый код ошибки
     */
    static readonly code = "INVALID_DIVISOR";
}
//# sourceMappingURL=InvalidDivisorError.d.ts.map