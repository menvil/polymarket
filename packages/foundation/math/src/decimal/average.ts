import Decimal from 'decimal.js';
import { ArithmeticOverflowError } from '@polymarket/errors';
import { MATH_CONSTANTS } from '../constants.js';

/**
 * Вычисляет среднее значение двух Decimal чисел
 *
 * @param a - Первое число
 * @param b - Второе число
 * @returns Среднее значение (a + b) / 2
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция без бизнес-правил.
 * Алгоритм: (a + b) / 2
 *
 * Throw = математическая невозможность (overflow, NaN, Infinity).
 *
 * НЕ проверяет:
 * - Знаки операндов (это бизнес-правило)
 * - Минимальные/максимальные значения (это бизнес-правило)
 * - Является ли результат "валидным" для конкретного домена
 *
 * @example
 * ```typescript
 * const avg1 = averageDecimal(new Decimal(10), new Decimal(20));
 * console.log(avg1.toString()); // "15"
 *
 * const avg2 = averageDecimal(new Decimal(0.5), new Decimal(0.7));
 * console.log(avg2.toString()); // "0.6"
 *
 * // Работает с отрицательными числами
 * const avg3 = averageDecimal(new Decimal(-10), new Decimal(10));
 * console.log(avg3.toString()); // "0"
 *
 * // Throw на overflow
 * const huge = new Decimal('1e308');
 * averageDecimal(huge, huge); // throws ArithmeticOverflowError
 * ```
 */
export function averageDecimal(a: Decimal, b: Decimal): Decimal {
  const sum = a.plus(b);
  const result = sum.dividedBy(MATH_CONSTANTS.TWO);

  if (!result.isFinite()) {
    throw new ArithmeticOverflowError(
      (ctx) =>
        `Average operation resulted in non-finite value: ${ctx.result}`,
      {
        context: {
          operation: 'average',
          operand1: a.toString(),
          operand2: b.toString(),
          result: result.toString(),
        },
      }
    );
  }

  return result;
}
