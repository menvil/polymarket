/**
 * ArithmeticOverflowError - ошибка переполнения при арифметических операциях
 *
 * @remarks
 * Выбрасывается когда результат арифметической операции превышает допустимые границы
 * или приводит к Infinity/-Infinity.
 *
 * Типичные случаи:
 * - Сложение/вычитание очень больших чисел: 1e308 + 1e308 = Infinity
 * - Умножение больших значений: 1e200 * 1e200 = Infinity
 * - Экспоненциальные операции: Math.pow(10, 1000) = Infinity
 * - Операции с decimal.js, когда результат выходит за допустимые пределы
 *
 * Особенно важно для финансовых расчетов, где точность критична.
 * Уровень серьезности: low (математические ошибки обычно обрабатываются локально).
 *
 * @example
 * ```typescript
 * import { ArithmeticOverflowError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new ArithmeticOverflowError('Arithmetic overflow: result too large');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new ArithmeticOverflowError('Arithmetic overflow', {
 *   code: ArithmeticOverflowError.code,
 *   context: { operation: 'multiplication', result: Infinity, a: 1e308, b: 10 }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new ArithmeticOverflowError(
 *   (ctx) => `Overflow in ${ctx.operation}: result is ${ctx.result}`,
 *   {
 *     code: ArithmeticOverflowError.code,
 *     context: { operation: 'addition', result: Infinity }
 *   }
 * );
 * // "Overflow in addition: result is Infinity"
 *
 * // С операндами для отладки
 * throw new ArithmeticOverflowError(
 *   (ctx) => `${ctx.operation} overflow: ${ctx.a} * ${ctx.b} = ${ctx.result}`,
 *   {
 *     code: ArithmeticOverflowError.code,
 *     context: { operation: 'multiplication', a: 1e308, b: 10, result: Infinity }
 *   }
 * );
 * // "multiplication overflow: 1e+308 * 10 = Infinity"
 *
 * // В методе value object
 * public multiply(other: Money): Money {
 *   const result = this.amount * other.amount;
 *   if (!Number.isFinite(result)) {
 *     throw new ArithmeticOverflowError(
 *       (ctx) => `Multiplication overflow: ${ctx.a} * ${ctx.b} = ${ctx.result}`,
 *       {
 *         code: ArithmeticOverflowError.code,
 *         context: { a: this.amount, b: other.amount, result }
 *       }
 *     );
 *   }
 *   return new Money(result, this.currency);
 * }
 * ```
 */
import { TradingError } from '../base/index.js';
/**
 * ArithmeticOverflowError - ошибка переполнения при арифметических операциях
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: ARITHMETIC_OVERFLOW
 */
export class ArithmeticOverflowError extends TradingError {
    severity = 'low';
    /**
     * Рекомендуемый код ошибки
     */
    static code = 'ARITHMETIC_OVERFLOW';
}
//# sourceMappingURL=ArithmeticOverflowError.js.map