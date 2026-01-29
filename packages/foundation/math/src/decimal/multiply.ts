import Decimal from 'decimal.js';
import {
  ArithmeticOverflowError,
  InvalidOperandError,
} from '@polymarket/errors';

/**
 * Умножает два Decimal значения
 *
 * @param a - Первый множитель
 * @param b - Второй множитель
 * @returns Произведение a * b
 * @throws {InvalidOperandError} Если операнды не конечные числа (NaN/Infinity)
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция без бизнес-правил.
 *
 * Проверяет только математическую корректность:
 * - Оба операнда должны быть finite (не NaN, не Infinity)
 * - Результат должен быть finite
 *
 * @example
 * ```typescript
 * multiplyDecimal(new Decimal(5), new Decimal(3)); // 15
 * multiplyDecimal(new Decimal(2.5), new Decimal(4)); // 10
 *
 * // Throw на invalid operand
 * multiplyDecimal(new Decimal(NaN), new Decimal(5)); // throws InvalidOperandError
 * multiplyDecimal(new Decimal(Infinity), new Decimal(5)); // throws InvalidOperandError
 *
 * // Throw на overflow
 * const huge = new Decimal('1e308');
 * multiplyDecimal(huge, huge); // throws ArithmeticOverflowError
 * ```
 */
export function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  // Проверка 1: Оба операнда должны быть конечными числами
  if (!a.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Operand 'a' must be finite, got ${ctx.a}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'multiply',
        },
      }
    );
  }

  if (!b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Operand 'b' must be finite, got ${ctx.b}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'multiply',
        },
      }
    );
  }

  // Выполняем умножение
  const result = a.times(b);

  // Проверка 2: Результат должен быть конечным
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
