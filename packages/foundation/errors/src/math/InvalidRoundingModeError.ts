import { TradingError } from '../base/index.js';
import type { ErrorSeverity } from '../base/index.js';

/**
 * InvalidRoundingModeError - ошибка невалидного режима округления
 *
 * @remarks
 * Выбрасывается при попытке округления с невалидным roundingMode (не integer, вне диапазона 0-8).
 * Это математическая невозможность, а не бизнес-правило.
 *
 * Decimal.js поддерживает режимы округления от 0 до 8:
 * - 0: ROUND_UP - от нуля
 * - 1: ROUND_DOWN - к нулю
 * - 2: ROUND_CEIL - к +Infinity
 * - 3: ROUND_FLOOR - к -Infinity
 * - 4: ROUND_HALF_UP - к ближайшему, .5 вверх
 * - 5: ROUND_HALF_DOWN - к ближайшему, .5 вниз
 * - 6: ROUND_HALF_EVEN - к ближайшему, .5 к чётному
 * - 7: ROUND_HALF_CEIL - к ближайшему, .5 к +Infinity
 * - 8: ROUND_HALF_FLOOR - к ближайшему, .5 к -Infinity
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 * Рекомендуемый код ошибки: INVALID_ROUNDING_MODE
 *
 * @example
 * ```typescript
 * import { InvalidRoundingModeError } from '@polymarket/errors';
 *
 * // С динамическим сообщением
 * throw new InvalidRoundingModeError(
 *   (ctx) => `Rounding mode must be an integer between 0 and 8, got ${ctx.roundingMode}`,
 *   {
 *     context: { roundingMode: '9', value: '10.567', operation: 'roundToPrecision' }
 *   }
 * );
 *
 * // Статическое сообщение
 * throw new InvalidRoundingModeError('Invalid rounding mode', {
 *   context: { roundingMode: 'NaN', value: '10.567', operation: 'roundToPrecision' }
 * });
 * ```
 */
export class InvalidRoundingModeError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_ROUNDING_MODE';
}
