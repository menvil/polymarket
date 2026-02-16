import Decimal from 'decimal.js';
import {
  DivisionByZeroError,
  InvalidDivisorError,
  InvalidOperandError,
} from '@polymarket/errors';
import { assertFiniteResult } from '../shared/index.js';

/**
 * Делит одно Decimal значение на другое
 *
 * @param dividend - Делимое
 * @param divisor - Делитель
 * @returns Частное dividend / divisor
 * @throws {InvalidOperandError} Если делимое не конечное число (NaN/Infinity)
 * @throws {InvalidDivisorError} Если делитель не конечное число (NaN/Infinity)
 * @throws {DivisionByZeroError} Если делитель равен нулю
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция.
 *
 * Проверяет только математическую корректность:
 * - dividend должен быть finite (не NaN, не Infinity)
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
 * // Throw на overflow (при превышении Decimal.maxE)
 * // Примечание: Decimal.maxE = 9e15, поэтому 1e308 / 1e-308 = 1e616 это finite
 * const huge = new Decimal('1e9000000000000000');
 * const tiny = new Decimal('1e-100');
 * divideDecimal(huge, tiny); // throws ArithmeticOverflowError
 * ```
 */
export function divideDecimal(dividend: Decimal, divisor: Decimal): Decimal {
  const context = {
    operation: 'divide',
    dividend: dividend.toString(),
    divisor: divisor.toString(),
  };

  // Проверка делимого
  if (!dividend.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Dividend must be finite, got ${ctx.dividend}`,
      { context }
    );
  }

  // Проверка делителя
  if (!divisor.isFinite()) {
    throw new InvalidDivisorError(
      (ctx) => `Divisor must be finite, got ${ctx.divisor}`,
      { context }
    );
  }

  // Проверка на ноль
  if (divisor.isZero()) {
    throw new DivisionByZeroError(() => 'Cannot divide by zero', { context });
  }

  // Выполняем деление
  const result = dividend.div(divisor);

  // Проверка результата
  assertFiniteResult(result, { ...context, result: result.toString() });

  return result;
}
