/**
 * InvalidTickSizeError - ошибка невалидного размера тика
 *
 * @remarks
 * Выбрасывается когда tickSize <= 0 или не является конечным числом.
 * Это математическая невозможность, а не бизнес-правило.
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidTickSizeError } from '@polymarket/errors';
 *
 * // С динамическим сообщением
 * throw new InvalidTickSizeError(
 *   (ctx) => `Tick size must be finite and positive, got ${ctx.tickSize}`,
 *   {
 *     code: InvalidTickSizeError.code,
 *     context: { tickSize: 0, value: 10.567 }
 *   }
 * );
 *
 * // Статическое сообщение
 * throw new InvalidTickSizeError('Invalid tick size', {
 *   code: InvalidTickSizeError.code,
 *   context: { tickSize: -0.01 }
 * });
 * ```
 */

import { TradingError } from '../base/index.js';
import type { ErrorSeverity } from '../base/index.js';

/**
 * InvalidTickSizeError - ошибка невалидного размера тика
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_TICK_SIZE
 */
export class InvalidTickSizeError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_TICK_SIZE';
}
