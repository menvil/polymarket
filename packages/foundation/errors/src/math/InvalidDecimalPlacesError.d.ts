import { TradingError } from '../base/index.js';
import type { ErrorSeverity } from '../base/index.js';
/**
 * InvalidDecimalPlacesError - ошибка невалидного количества десятичных знаков
 *
 * @remarks
 * Выбрасывается при попытке округления с невалидным количеством знаков (отрицательное, NaN, Infinity).
 * Это математическая невозможность, а не бизнес-правило.
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 * Рекомендуемый код ошибки: INVALID_DECIMAL_PLACES
 *
 * @example
 * ```typescript
 * import { InvalidDecimalPlacesError } from '@polymarket/errors';
 *
 * // С динамическим сообщением
 * throw new InvalidDecimalPlacesError(
 *   (ctx) => `Decimal places must be non-negative integer, got ${ctx.decimalPlaces}`,
 *   {
 *     context: { decimalPlaces: '-1', value: '10.567', operation: 'roundToPrecision' }
 *   }
 * );
 *
 * // Статическое сообщение
 * throw new InvalidDecimalPlacesError('Invalid decimal places', {
 *   context: { decimalPlaces: 'NaN', value: '10.567', operation: 'roundToPrecision' }
 * });
 * ```
 */
export declare class InvalidDecimalPlacesError extends TradingError {
    readonly severity: ErrorSeverity;
    /**
     * Рекомендуемый код ошибки
     */
    static readonly code = "INVALID_DECIMAL_PLACES";
}
//# sourceMappingURL=InvalidDecimalPlacesError.d.ts.map