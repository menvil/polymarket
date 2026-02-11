/**
 * InvalidPriceError - ошибка валидации цены
 *
 * @remarks
 * Выбрасывается когда значение цены не находится в допустимом диапазоне.
 * Для рынков Polymarket цена должна быть в диапазоне [0.0001, 0.9999].
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidPriceError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidPriceError('Invalid price: -0.5');
 *
 * // С кодом и контекстом для отладки (рекомендуется)
 * throw new InvalidPriceError('Invalid price', {
 *   code: InvalidPriceError.code,  // Используем статический код
 *   context: { value: -0.5, min: 0.0001, max: 0.9999 }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidPriceError(
 *   (ctx) => `Invalid price ${ctx.value}: must be in range [${ctx.min}, ${ctx.max}]`,
 *   {
 *     code: InvalidPriceError.code,
 *     context: { value: -0.5, min: 0.0001, max: 0.9999 }
 *   }
 * );
 * // "Invalid price -0.5: must be in range [0.0001, 0.9999]"
 *
 * // Проверка типа ошибки
 * try {
 *   validatePrice(-0.5);
 * } catch (error) {
 *   if (InvalidPriceError.is(error)) {
 *     console.log('Error code:', error.code); // 'INVALID_PRICE'
 *     console.log('Invalid price:', error.context?.value);
 *     console.log('Valid range:', error.context?.min, '-', error.context?.max);
 *   }
 * }
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * InvalidPriceError - ошибка валидации цены
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_PRICE
 */
export class InvalidPriceError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   *
   * @remarks
   * Используйте этот код при создании ошибки:
   * ```typescript
   * throw new InvalidPriceError('message', {
   *   code: InvalidPriceError.code,
   *   context: { ... }
   * });
   * ```
   */
  public static readonly code = 'INVALID_PRICE';
}
