/**
 * InvalidDivisorError - ошибка невалидного делителя
 *
 * @remarks
 * Выбрасывается при попытке деления на невалидное значение (NaN, Infinity).
 * Это математическая невозможность, а не бизнес-правило.
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidDivisorError } from '@polymarket/errors';
 *
 * // С динамическим сообщением
 * throw new InvalidDivisorError(
 *   (ctx) => `Divisor must be finite, got ${ctx.divisor}`,
 *   {
 *     code: InvalidDivisorError.code,
 *     context: { divisor: 'Infinity', dividend: '100' }
 *   }
 * );
 *
 * // Статическое сообщение
 * throw new InvalidDivisorError('Invalid divisor', {
 *   code: InvalidDivisorError.code,
 *   context: { divisor: NaN }
 * });
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * InvalidDivisorError - ошибка невалидного делителя
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_DIVISOR
 */
export class InvalidDivisorError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_DIVISOR';
}
