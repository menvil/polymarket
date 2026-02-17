import Decimal from 'decimal.js';
import {
  DivisionByZeroError,
  InvalidDivisorError,
  InvalidOperandError,
} from '@polymarket/errors';
import { assertFiniteResult, assertFiniteOperandWith, toStringSafe } from '../shared/index.js';

/**
 * Делит одно Decimal значение на другое
 *
 * @param a - Делимое (dividend)
 * @param b - Делитель (divisor)
 * @returns Частное a / b
 * @throws {InvalidOperandError} Если делимое не конечное число (NaN/Infinity)
 * @throws {InvalidDivisorError} Если делитель не конечное число (NaN/Infinity)
 * @throws {DivisionByZeroError} Если делитель равен нулю
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция.
 *
 * Проверяет только математическую корректность:
 * - a (делимое) должен быть finite (не NaN, не Infinity)
 * - b (делитель) должен быть finite (не NaN, не Infinity)
 * - b (делитель) не должен быть нулём
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
export function divideDecimal(a: Decimal, b: Decimal): Decimal {
  // Создаём context используя toStringSafe для единообразия
  const context = {
    operation: 'divide',
    a: toStringSafe(a),
    b: toStringSafe(b),
  };

  // Проверка делимого через unified assertion (InvalidOperandError)
  assertFiniteOperandWith(a, 'a', context, InvalidOperandError);

  // Проверка делителя через unified assertion (InvalidDivisorError)
  assertFiniteOperandWith(b, 'b', context, InvalidDivisorError);

  // Проверка на ноль (специфично для деления)
  // Defensive: проверяем наличие метода isZero перед вызовом
  const divisor = b as unknown as Record<string, unknown>;
  if (typeof divisor.isZero !== 'function') {
    throw new InvalidDivisorError(
      (ctx) => `Operand 'b' (divisor) must have isZero method, got ${ctx.b}`,
      { context }
    );
  }

  if (b.isZero()) {
    throw new DivisionByZeroError(
      (ctx) => `Cannot divide by zero (operand 'b' is ${ctx.b})`,
      { context }
    );
  }

  // Выполняем деление
  const result = a.div(b);

  // Проверка результата
  assertFiniteResult(result, { ...context, result: result.toString() });

  return result;
}
