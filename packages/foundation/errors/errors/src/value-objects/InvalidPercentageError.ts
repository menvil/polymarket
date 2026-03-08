/**
 * InvalidPercentageError - ошибка валидации процентного значения
 *
 * @remarks
 * Выбрасывается когда процентное значение выходит за допустимые границы.
 * Процент может быть представлен в двух форматах:
 * - [0, 100] - обычный формат (50 = 50%)
 * - [0, 1] - дробный формат (0.5 = 50%)
 *
 * Используется для валидации комиссий, процентов прибыли, slippage и других процентных величин.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidPercentageError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidPercentageError('Percentage must be between 0 and 100');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new InvalidPercentageError('Invalid percentage', {
 *   code: InvalidPercentageError.code,
 *   context: { value: 150, min: 0, max: 100 }
 * });
 *
 * // Динамическое сообщение из контекста (формат [0, 100])
 * throw new InvalidPercentageError(
 *   (ctx) => `Invalid percentage ${ctx.value}: must be in range [${ctx.min}, ${ctx.max}]`,
 *   {
 *     code: InvalidPercentageError.code,
 *     context: { value: 150, min: 0, max: 100 }
 *   }
 * );
 * // "Invalid percentage 150: must be in range [0, 100]"
 *
 * // Дробный формат [0, 1]
 * throw new InvalidPercentageError(
 *   (ctx) => `Invalid percentage ${ctx.value}: must be between ${ctx.min} and ${ctx.max}`,
 *   {
 *     code: InvalidPercentageError.code,
 *     context: { value: 1.5, min: 0, max: 1 }
 *   }
 * );
 * // "Invalid percentage 1.5: must be between 0 and 1"
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * InvalidPercentageError - ошибка валидации процентного значения
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_PERCENTAGE
 */
export class InvalidPercentageError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_PERCENTAGE';
}
