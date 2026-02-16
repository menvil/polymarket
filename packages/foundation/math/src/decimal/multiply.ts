import Decimal from 'decimal.js';
import { assertFiniteOperands, assertFiniteResult } from '../shared/index.js';

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
 * // Примечание: 1e308 * 1e308 = 1e616 это finite (в пределах maxE)
 * // Реальный overflow требует экстремальных значений, превышающих maxE
 * const huge = new Decimal('1e9000000000000001'); // Уже Infinity (превышает maxE)
 * multiplyDecimal(huge, new Decimal(2)); // throws InvalidOperandError (operand не finite)
 * ```
 */
export function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  // Создаём context безопасным способом
  const context = {
    operation: 'multiply',
    a: a && typeof a.toString === 'function' ? a.toString() : String(a),
    b: b && typeof b.toString === 'function' ? b.toString() : String(b),
  };

  // Валидация операндов
  assertFiniteOperands(a, b, context);

  // Выполняем умножение
  const result = a.times(b);

  // Проверка результата
  assertFiniteResult(result, { ...context, result: result.toString() });

  return result;
}
