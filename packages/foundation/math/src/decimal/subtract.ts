import Decimal from 'decimal.js';
import { assertFiniteOperands, assertFiniteResult } from '../shared/index.js';

/**
 * Вычитает одно Decimal значение из другого
 *
 * @param a - Уменьшаемое
 * @param b - Вычитаемое
 * @returns Разность a - b
 * @throws {InvalidOperandError} Если операнды не конечные числа (NaN/Infinity)
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция.
 * НЕ проверяет что результат >= 0 (это бизнес-правило для Quantity).
 * Математически разрешены отрицательные результаты.
 *
 * Проверяет только математическую корректность:
 * - Оба операнда должны быть finite (не NaN, не Infinity)
 * - Результат должен быть finite
 *
 * @example
 * ```typescript
 * subtractDecimal(new Decimal(10), new Decimal(3)); // 7
 * subtractDecimal(new Decimal(3), new Decimal(10)); // -7 (математически валидно!)
 *
 * // Throw на invalid operand
 * subtractDecimal(new Decimal(NaN), new Decimal(5)); // throws InvalidOperandError
 * subtractDecimal(new Decimal(Infinity), new Decimal(5)); // throws InvalidOperandError
 * ```
 */
export function subtractDecimal(a: Decimal, b: Decimal): Decimal {
  const context = {
    operation: 'subtract',
    a: a.toString(),
    b: b.toString(),
  };

  // Валидация операндов
  assertFiniteOperands(a, b, context);

  // Выполняем вычитание
  const result = a.minus(b);

  // Проверка результата
  assertFiniteResult(result, { ...context, result: result.toString() });

  return result;
}
