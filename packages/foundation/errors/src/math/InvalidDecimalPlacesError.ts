/**
 * InvalidDecimalPlacesError - ошибка невалидного количества десятичных знаков
 *
 * @remarks
 * Выбрасывается при попытке округления с невалидным количеством знаков (отрицательное, NaN, Infinity).
 * Это математическая невозможность, а не бизнес-правило.
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
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

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * InvalidDecimalPlacesError - ошибка невалидного количества десятичных знаков
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_DECIMAL_PLACES
 */
export class InvalidDecimalPlacesError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_DECIMAL_PLACES';
}
