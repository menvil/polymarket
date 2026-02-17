import Decimal from 'decimal.js';
import { assertFiniteOperands, assertFiniteResult, withResult, toStringSafe } from '../shared/index.js';

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
 * // Throw на overflow (при превышении Decimal.maxE = 9e15)
 * // Операнды валидны (finite), но результат превышает maxE
 * const huge = new Decimal('1e' + (Math.floor(Decimal.maxE / 2) + 1));
 * multiplyDecimal(huge, huge); // throws ArithmeticOverflowError (результат = Infinity)
 * ```
 */
export function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  const context = {
    operation: 'multiply',
    a: toStringSafe(a),
    b: toStringSafe(b),
  };

  assertFiniteOperands(a, b, context);

  const result = a.times(b);

  assertFiniteResult(result, withResult(context, result));

  return result;
}
