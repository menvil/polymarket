import Decimal from 'decimal.js';
import {
  DivisionByZeroError,
  ArithmeticOverflowError,
  InvalidDivisorError,
} from '@polymarket/errors';

/**
 * Делит одно Decimal значение на другое
 *
 * @param dividend - Делимое
 * @param divisor - Делитель
 * @returns Частное dividend / divisor
 * @throws {InvalidDivisorError} Если делитель не конечное число (NaN/Infinity)
 * @throws {DivisionByZeroError} Если делитель равен нулю
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция.
 *
 * Проверяет только математическую корректность:
 * - divisor должен быть finite (не NaN, не Infinity)
 * - divisor не должен быть нулём
 * - result должен быть finite
 *
 * НЕ проверяет:
 * - Знак делителя (математически можно делить на отрицательное)
 * - Минимальные значения
 *
 * Это бизнес-правила - они проверяются в Rules/Policy слоях.
 *
 * @example
 * ```typescript
 * // Нормальное деление
 * divideDecimal(new Decimal(10), new Decimal(2)); // 5
 * divideDecimal(new Decimal(10), new Decimal(3)); // 3.333...
 *
 * // Отрицательное деление (математически валидно!)
 * divideDecimal(new Decimal(10), new Decimal(-2)); // -5
 *
 * // Throw на невалидный делитель
 * divideDecimal(new Decimal(10), new Decimal(NaN)); // throws InvalidDivisorError
 * divideDecimal(new Decimal(10), new Decimal(Infinity)); // throws InvalidDivisorError
 *
 * // Throw на деление на ноль
 * divideDecimal(new Decimal(10), new Decimal(0)); // throws DivisionByZeroError
 *
 * // Throw на overflow
 * const huge = new Decimal('1e308');
 * const tiny = new Decimal('1e-308');
 * divideDecimal(huge, tiny); // throws ArithmeticOverflowError
 * ```
 */
export function divideDecimal(dividend: Decimal, divisor: Decimal): Decimal {
  // Проверка 1: Делитель должен быть конечным числом
  if (!divisor.isFinite()) {
    throw new InvalidDivisorError(
      (ctx) => `Divisor must be finite, got ${ctx.divisor}`,
      {
        context: {
          divisor: divisor.toString(),
          dividend: dividend.toString(),
        },
      }
    );
  }

  // Проверка 2: Делитель не должен быть нулём
  if (divisor.isZero()) {
    throw new DivisionByZeroError(() => 'Cannot divide by zero', {
      context: {
        dividend: dividend.toString(),
        divisor: divisor.toString(),
      },
    });
  }

  // Выполняем деление
  const result = dividend.div(divisor);

  // Проверка 3: Результат должен быть конечным
  if (!result.isFinite()) {
    throw new ArithmeticOverflowError(
      (ctx) =>
        `Division overflow: ${ctx.dividend} / ${ctx.divisor} = ${ctx.result}`,
      {
        context: {
          dividend: dividend.toString(),
          divisor: divisor.toString(),
          result: result.toString(),
        },
      }
    );
  }

  return result;
}
