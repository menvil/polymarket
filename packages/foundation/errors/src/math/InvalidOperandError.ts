/**
 * InvalidOperandError - ошибка невалидного операнда
 *
 * @remarks
 * Выбрасывается при попытке арифметической операции с невалидным значением (NaN, Infinity).
 * Это математическая невозможность, а не бизнес-правило.
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
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

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * InvalidOperandError - ошибка невалидного операнда
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_OPERAND
 */
export class InvalidOperandError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_OPERAND';
}
