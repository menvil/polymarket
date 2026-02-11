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
 * // С кодом и контекстом (рекомендуется)
 * throw new InvalidRatioError('Invalid ratio value', {
 *   code: InvalidRatioError.code,
 *   context: { ratioValue: NaN }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidRatioError(
 *   (ctx) => `Invalid ratio value ${ctx.ratioValue}: must be finite`,
 *   {
 *     code: InvalidRatioError.code,
 *     context: { ratioValue: Infinity }
 *   }
 * );
 * // "Invalid ratio value Infinity: must be finite"
 *
 * // С типизированной причиной ошибки
 * throw new InvalidRatioError('Ratio must be >= -1', {
 *   code: InvalidRatioError.code,
 *   context: {
 *     ratioValue: '-1.5',
 *     reason: 'LESS_THAN_MINUS_ONE',
 *     op: 'fromDecimal'
 *   }
 * });
 * ```
 */

import { TradingError, ErrorSeverity } from '../base';

/**
 * InvalidRatioError - ошибка валидации коэффициента
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_RATIO
 */
export class InvalidRatioError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_RATIO';
}
