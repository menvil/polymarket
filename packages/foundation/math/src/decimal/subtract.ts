import Decimal from 'decimal.js';
import { ArithmeticOverflowError } from '@polymarket/errors';

/**
 * Вычитает одно Decimal значение из другого
 *
 * @param a - Уменьшаемое
 * @param b - Вычитаемое
 * @returns Разность a - b
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция.
 * НЕ проверяет что результат >= 0 (это бизнес-правило для Quantity).
 * Математически разрешены отрицательные результаты.
 *
 * @example
 * ```typescript
 * subtractDecimal(new Decimal(10), new Decimal(3)); // 7
 * subtractDecimal(new Decimal(3), new Decimal(10)); // -7 (математически валидно!)
 * ```
 */
export function subtractDecimal(a: Decimal, b: Decimal): Decimal {
  const result = a.minus(b);

  if (!result.isFinite()) {
    throw new ArithmeticOverflowError(
      (ctx) => `Subtraction overflow: ${ctx.a} - ${ctx.b} = ${ctx.result}`,
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
