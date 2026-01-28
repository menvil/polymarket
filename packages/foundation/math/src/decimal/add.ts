import Decimal from 'decimal.js';
import {
  ArithmeticOverflowError,
  InvalidOperandError,
} from '@polymarket/errors';

/**
 * Складывает два Decimal значения
 *
 * @param a - Первое слагаемое
 * @param b - Второе слагаемое
 * @returns Сумма a + b
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
 * НЕ проверяет:
 * - Знаки операндов (это бизнес-правило)
 * - Минимальные/максимальные значения (это бизнес-правило)
 *
 * @example
 * ```typescript
 * const result = addDecimal(new Decimal(5), new Decimal(3));
 * console.log(result.toString()); // "8"
 *
 * // Throw на invalid operand
 * addDecimal(new Decimal(NaN), new Decimal(5)); // throws InvalidOperandError
 * addDecimal(new Decimal(Infinity), new Decimal(5)); // throws InvalidOperandError
 *
 * // Throw на overflow
 * const huge = new Decimal('1e308');
 * addDecimal(huge, huge); // throws ArithmeticOverflowError
 * ```
 */
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  // Проверка 1: Оба операнда должны быть конечными числами
  if (!a.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Operand 'a' must be finite, got ${ctx.a}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'add',
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
          operation: 'add',
        },
      }
    );
  }

  // Выполняем сложение
  const result = a.plus(b);

  // Проверка 2: Результат должен быть конечным
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
