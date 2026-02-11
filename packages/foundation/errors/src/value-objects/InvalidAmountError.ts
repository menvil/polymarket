/**
 * InvalidAmountError - ошибка валидации универсального числового значения
 *
 * @remarks
 * Выбрасывается когда числовое значение (amount) выходит за допустимые границы
 * или имеет некорректный формат. Это более общая ошибка, чем специфичные
 * InvalidMoneyError или InvalidQuantityError.
 *
 * Используется для:
 * - Валидации leverage (кредитное плечо)
 * - Валидации slippage tolerance
 * - Валидации fee amounts
 * - Других универсальных числовых параметров
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidAmountError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidAmountError('Balance must be non-negative');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new InvalidAmountError('Invalid amount', {
 *   code: InvalidAmountError.code,
 *   context: { field: 'leverage', value: 150, min: 1, max: 100 }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidAmountError(
 *   (ctx) => `Invalid ${ctx.field}: ${ctx.value} (must be in range [${ctx.min}, ${ctx.max}])`,
 *   {
 *     code: InvalidAmountError.code,
 *     context: { field: 'leverage', value: 150, min: 1, max: 100 }
 *   }
 * );
 * // "Invalid leverage: 150 (must be in range [1, 100])"
 *
 * // С условной логикой для разных типов ошибок
 * throw new InvalidAmountError(
 *   (ctx) => {
 *     if (Number.isNaN(ctx.value)) return `${ctx.field} must be a valid number`;
 *     if (ctx.min !== undefined && ctx.value < ctx.min) {
 *       return `${ctx.field} ${ctx.value} is below minimum of ${ctx.min}`;
 *     }
 *     if (ctx.max !== undefined && ctx.value > ctx.max) {
 *       return `${ctx.field} ${ctx.value} exceeds maximum of ${ctx.max}`;
 *     }
 *     return `Invalid ${ctx.field}: ${ctx.value}`;
 *   },
 *   {
 *     code: InvalidAmountError.code,
 *     context: { field: 'slippage', value: NaN }
 *   }
 * );
 * // "slippage must be a valid number"
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * InvalidAmountError - ошибка валидации универсального числового значения
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_AMOUNT
 */
export class InvalidAmountError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_AMOUNT';
}
