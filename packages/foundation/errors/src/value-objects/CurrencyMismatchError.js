/**
 * CurrencyMismatchError - ошибка несоответствия валют
 *
 * @remarks
 * Выбрасывается при попытке выполнить операцию с денежными значениями
 * в разных валютах без явной конвертации.
 *
 * Типичные случаи:
 * - Сложение: Money(100, 'USDC') + Money(50, 'EUR') - нельзя складывать напрямую
 * - Вычитание: Money(100, 'USDC') - Money(50, 'BTC') - нельзя вычитать напрямую
 * - Сравнение: Money(100, 'USDC') > Money(50, 'EUR') - нельзя сравнивать напрямую
 *
 * Для операций с разными валютами необходима явная конвертация.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { CurrencyMismatchError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new CurrencyMismatchError('Cannot operate with different currencies');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new CurrencyMismatchError('Currency mismatch', {
 *   code: CurrencyMismatchError.code,
 *   context: { operation: 'addition', expected: 'USDC', actual: 'EUR' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new CurrencyMismatchError(
 *   (ctx) => `Cannot ${ctx.operation}: ${ctx.expected} != ${ctx.actual}`,
 *   {
 *     code: CurrencyMismatchError.code,
 *     context: { operation: 'add', expected: 'USDC', actual: 'EUR' }
 *   }
 * );
 * // "Cannot add: USDC != EUR"
 *
 * // С более детальным описанием
 * throw new CurrencyMismatchError(
 *   (ctx) => `Currency mismatch in ${ctx.operation}: cannot operate with ${ctx.expected} and ${ctx.actual}`,
 *   {
 *     code: CurrencyMismatchError.code,
 *     context: { operation: 'subtraction', expected: 'USDC', actual: 'BTC' }
 *   }
 * );
 * // "Currency mismatch in subtraction: cannot operate with USDC and BTC"
 *
 * // В методе value object
 * public add(other: Money): Money {
 *   if (this.currency !== other.currency) {
 *     throw new CurrencyMismatchError(
 *       (ctx) => `Cannot add ${ctx.actual} to ${ctx.expected}. Convert currencies first.`,
 *       {
 *         code: CurrencyMismatchError.code,
 *         context: { operation: 'add', expected: this.currency, actual: other.currency }
 *       }
 *     );
 *   }
 *   return new Money(this.amount + other.amount, this.currency);
 * }
 * ```
 */
import { TradingError } from '../base/index.js';
/**
 * CurrencyMismatchError - ошибка несоответствия валют
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: CURRENCY_MISMATCH
 */
export class CurrencyMismatchError extends TradingError {
    severity = 'low';
    /**
     * Рекомендуемый код ошибки
     */
    static code = 'CURRENCY_MISMATCH';
}
//# sourceMappingURL=CurrencyMismatchError.js.map