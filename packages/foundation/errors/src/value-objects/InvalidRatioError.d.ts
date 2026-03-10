/**
 * InvalidRatioError - ошибка валидации коэффициента (ratio)
 *
 * @remarks
 * Выбрасывается когда коэффициент имеет некорректное значение:
 * - NaN (не число)
 * - Infinity или -Infinity
 * - Некорректный формат при парсинге
 * - Нарушение domain rules (например, ratio < -1 когда требуется >= -1)
 *
 * Используется в value object Ratio для валидации значений.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidRatioError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidRatioError('Ratio cannot be NaN');
 *
 * // С контекстом (рекомендуется)
 * throw new InvalidRatioError('Invalid ratio value', {
 *   context: { ratioValue: NaN }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidRatioError(
 *   (ctx) => `Invalid ratio value ${ctx.ratioValue}: must be finite`,
 *   {
 *     context: { ratioValue: Infinity }
 *   }
 * );
 * // "Invalid ratio value Infinity: must be finite"
 *
 * // С типизированной причиной ошибки
 * throw new InvalidRatioError('Ratio must be >= -1', {
 *   context: {
 *     ratioValue: '-1.5',
 *     reason: 'LESS_THAN_MINUS_ONE',
 *     op: 'fromDecimal'
 *   }
 * });
 * ```
 */
import { TradingError, ErrorSeverity } from '../base/index.js';
/**
 * InvalidRatioError - ошибка валидации коэффициента
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_RATIO
 */
export declare class InvalidRatioError extends TradingError {
    readonly severity: ErrorSeverity;
    /**
     * Рекомендуемый код ошибки
     */
    static readonly code = "INVALID_RATIO";
}
//# sourceMappingURL=InvalidRatioError.d.ts.map