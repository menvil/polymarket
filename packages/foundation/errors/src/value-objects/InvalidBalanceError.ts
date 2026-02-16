/**
 * InvalidBalanceError - ошибка валидации баланса
 *
 * @remarks
 * Выбрасывается когда баланс имеет некорректное значение:
 * - Отрицательный available amount
 * - Отрицательный reserved amount
 * - Несовпадение валют между available и reserved
 * - Недостаточно средств для резервирования
 * - Недостаточно зарезервированных средств для освобождения
 *
 * Используется в value object Balance для валидации операций с балансом.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidBalanceError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidBalanceError('Available amount cannot be negative');
 *
 * // С контекстом (рекомендуется)
 * throw new InvalidBalanceError('Invalid balance', {
 *   context: { available: -100, reserved: 0, currency: 'USDC' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidBalanceError(
 *   (ctx) => `Cannot reserve ${ctx.amount}: only ${ctx.available} available`,
 *   {
 *     context: { amount: 1000, available: 500, currency: 'USDC', reason: 'INSUFFICIENT_FUNDS' }
 *   }
 * );
 * // "Cannot reserve 1000: only 500 available"
 *
 * // С типизированным reason
 * throw new InvalidBalanceError(
 *   (ctx) => {
 *     if (ctx.reason === 'INSUFFICIENT_FUNDS') return `Not enough funds available`;
 *     if (ctx.reason === 'CURRENCY_MISMATCH') return `Currency mismatch detected`;
 *     return `Invalid balance operation`;
 *   },
 *   {
 *     context: { reason: 'INSUFFICIENT_FUNDS', available: 100, requested: 500 }
 *   }
 * );
 * // "Not enough funds available"
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

export class InvalidBalanceError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_BALANCE';
}
