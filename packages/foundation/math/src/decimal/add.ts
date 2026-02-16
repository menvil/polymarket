import Decimal from 'decimal.js';
import { assertFiniteOperands, assertFiniteResult } from '../shared/index.js';

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
 * ```
 */
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  // Создаём context безопасным способом
  const context = {
    operation: 'add',
    a: a && typeof a.toString === 'function' ? a.toString() : String(a),
    b: b && typeof b.toString === 'function' ? b.toString() : String(b),
  };

  // Валидация операндов
  assertFiniteOperands(a, b, context);

  // Выполняем сложение
  const result = a.plus(b);

  // Проверка результата
  assertFiniteResult(result, { ...context, result: result.toString() });

  return result;
}
