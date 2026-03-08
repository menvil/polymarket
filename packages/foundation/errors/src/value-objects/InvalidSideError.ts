/**
 * InvalidSideError - ошибка валидации стороны сделки
 *
 * @remarks
 * Выбрасывается когда сторона сделки имеет некорректное значение:
 * - Не 'BUY' и не 'SELL'
 * - Неправильный регистр ('buy', 'Buy', 'BUYING')
 * - Пустая строка или null/undefined
 * - Некорректный формат
 *
 * Используется в value object Side при создании и валидации.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidSideError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidSideError('Side must be BUY or SELL');
 *
 * // С контекстом (рекомендуется)
 * throw new InvalidSideError('Invalid side value', {
 *   context: { value: 'UNKNOWN', reason: 'INVALID_VALUE' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidSideError(
 *   (ctx) => `Invalid side: "${ctx.value}". Expected BUY or SELL`,
 *   {
 *     context: { value: 'buy', reason: 'INVALID_VALUE' }
 *   }
 * );
 * // "Invalid side: "buy". Expected BUY or SELL"
 *
 * // С условной логикой в template
 * throw new InvalidSideError(
 *   (ctx) => ctx.value === ''
 *     ? 'Side cannot be empty'
 *     : `Invalid side value: "${ctx.value}"`,
 *   {
 *     context: { value: '', reason: 'EMPTY' }
 *   }
 * );
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * InvalidSideError - ошибка валидации стороны сделки
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_SIDE
 */
export class InvalidSideError extends TradingError {
  public override readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_SIDE';
}
