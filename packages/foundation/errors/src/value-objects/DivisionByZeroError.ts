/**
 * DivisionByZeroError - ошибка деления на ноль
 *
 * @remarks
 * Выбрасывается при попытке выполнить операцию деления на ноль.
 * Это математическая ошибка, которая может возникнуть в арифметических
 * операциях value objects.
 *
 * Типичные случаи:
 * - Вычисление средней цены: totalCost / quantity (когда quantity = 0)
 * - Вычисление процента: profit / investment (когда investment = 0)
 * - Нормализация: value / total (когда total = 0)
 *
 * Уровень серьезности: low (математические ошибки обычно обрабатываются локально).
 *
 * @example
 * ```typescript
 * import { DivisionByZeroError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new DivisionByZeroError('Cannot divide by zero');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new DivisionByZeroError('Division by zero', {
 *   code: DivisionByZeroError.code,
 *   context: { dividend: 100, divisor: 0, operation: 'average price calculation' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new DivisionByZeroError(
 *   (ctx) => `Division by zero: ${ctx.dividend} / ${ctx.divisor}`,
 *   {
 *     code: DivisionByZeroError.code,
 *     context: { dividend: 100, divisor: 0 }
 *   }
 * );
 * // "Division by zero: 100 / 0"
 *
 * // С указанием операции
 * throw new DivisionByZeroError(
 *   (ctx) => `Cannot calculate ${ctx.operation}: divisor is zero`,
 *   {
 *     code: DivisionByZeroError.code,
 *     context: { dividend: 100, divisor: 0, operation: 'average price' }
 *   }
 * );
 * // "Cannot calculate average price: divisor is zero"
 *
 * // В методе value object
 * public divide(divisor: number): Money {
 *   if (divisor === 0) {
 *     throw new DivisionByZeroError(
 *       (ctx) => `Cannot divide ${ctx.amount} by ${ctx.divisor}`,
 *       {
 *         code: DivisionByZeroError.code,
 *         context: { amount: this.amount, divisor }
 *       }
 *     );
 *   }
 *   return new Money(this.amount / divisor, this.currency);
 * }
 * ```
 */

import { TradingError, ErrorSeverity } from '../base';

/**
 * DivisionByZeroError - ошибка деления на ноль
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: DIVISION_BY_ZERO
 */
export class DivisionByZeroError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'DIVISION_BY_ZERO';
}
