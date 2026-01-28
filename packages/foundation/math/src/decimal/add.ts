import Decimal from 'decimal.js';
import { ArithmeticOverflowError } from '@polymarket/errors';

/**
 * Складывает два Decimal значения
 *
 * @param a - Первое слагаемое
 * @param b - Второе слагаемое
 * @returns Сумма a + b
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция без бизнес-правил.
 * Throw = математическая невозможность (overflow).
 *
 * НЕ проверяет:
 * - Знаки операндов (это бизнес-правило)
 * - Минимальные/максимальные значения (это бизнес-правило)
 *
 * @example
 * ```typescript
 * const result = addDecimal(new Decimal(5), new Decimal(3));
 * console.log(result.toString()); // "8"
 *
 * // Throw на overflow
 * const huge = new Decimal('1e308');
 * addDecimal(huge, huge); // throws ArithmeticOverflowError
 * ```
 */
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const result = a.plus(b);

  if (!result.isFinite()) {
    throw new ArithmeticOverflowError(
      (ctx) => `Addition overflow: ${ctx.a} + ${ctx.b} = ${ctx.result}`,
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
