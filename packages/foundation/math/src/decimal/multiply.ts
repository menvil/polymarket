import Decimal from 'decimal.js';
import { ArithmeticOverflowError } from '@polymarket/errors';

/**
 * Умножает два Decimal значения
 *
 * @param a - Первый множитель
 * @param b - Второй множитель
 * @returns Произведение a * b
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @example
 * ```typescript
 * multiplyDecimal(new Decimal(5), new Decimal(3)); // 15
 * multiplyDecimal(new Decimal(2.5), new Decimal(4)); // 10
 * ```
 */
export function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  const result = a.times(b);

  if (!result.isFinite()) {
    throw new ArithmeticOverflowError(
      (ctx) => `Multiplication overflow: ${ctx.a} * ${ctx.b} = ${ctx.result}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          result: result.toString(),
        },
      }
    );
  }

  return result;
}
