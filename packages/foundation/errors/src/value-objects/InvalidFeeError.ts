/**
 * InvalidFeeError - ошибка валидации комиссии
 *
 * @remarks
 * Выбрасывается когда комиссия имеет некорректное значение:
 * - Отрицательная комиссия
 * - NaN или не число
 * - Infinity (не finite)
 * - Некорректный формат при парсинге
 * - Несоответствие валюты
 *
 * Используется в value object Fee при создании и валидации.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidFeeError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidFeeError('Fee cannot be negative');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new InvalidFeeError('Invalid fee value', {
 *   code: InvalidFeeError.code,
 *   context: { value: -1, reason: 'NEGATIVE' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidFeeError(
 *   (ctx) => `Invalid fee: ${ctx.reason}`,
 *   {
 *     code: InvalidFeeError.code,
 *     context: { value: NaN, reason: 'NOT_FINITE' }
 *   }
 * );
 * // "Invalid fee: NOT_FINITE"
 *
 * // С условной логикой в template
 * throw new InvalidFeeError(
 *   (ctx) => ctx.value < 0
 *     ? `Fee cannot be negative: ${ctx.value}`
 *     : `Invalid fee value: ${ctx.value}`,
 *   {
 *     code: InvalidFeeError.code,
 *     context: { value: -10, reason: 'NEGATIVE' }
 *   }
 * );
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * InvalidFeeError - ошибка валидации комиссии
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_FEE
 */
export class InvalidFeeError extends TradingError {
  public override readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_FEE';
}
