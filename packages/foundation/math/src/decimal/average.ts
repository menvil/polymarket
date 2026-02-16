import Decimal from 'decimal.js';
import { assertFiniteOperands, assertFiniteResult } from '../shared/index.js';
import { MATH_CONSTANTS } from '../constants.js';

/**
 * Вычисляет среднее значение двух Decimal чисел
 *
 * @param a - Первое число
 * @param b - Второе число
 * @returns Среднее значение (a + b) / 2
 * @throws {InvalidOperandError} Если операнды не конечные числа (NaN/Infinity)
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция без бизнес-правил.
 * Алгоритм: (a + b) / 2
 *
 * Проверяет только математическую корректность:
 * - Оба операнда должны быть finite (не NaN, не Infinity)
 * - Результат должен быть finite
 *
 * НЕ проверяет:
 * - Знаки операндов (это бизнес-правило)
 * - Минимальные/максимальные значения (это бизнес-правило)
 * - Является ли результат "валидным" для конкретного домена
 *
 * @example
 * ```typescript
 * const avg1 = averageDecimal(new Decimal(10), new Decimal(20));
 * console.log(avg1.toString()); // "15"
 *
 * const avg2 = averageDecimal(new Decimal(0.5), new Decimal(0.7));
 * console.log(avg2.toString()); // "0.6"
 *
 * // Работает с отрицательными числами
 * const avg3 = averageDecimal(new Decimal(-10), new Decimal(10));
 * console.log(avg3.toString()); // "0"
 *
 * // Throw на invalid operand
 * averageDecimal(new Decimal(NaN), new Decimal(5)); // throws InvalidOperandError
 * averageDecimal(new Decimal(Infinity), new Decimal(5)); // throws InvalidOperandError
 *
 * // Overflow при превышении Decimal.maxE = 9e15
 * // Примечание: average(a, b) = (a + b) / 2, overflow может произойти при сложении
 * // Значение 1e9000000000000001 уже превышает maxE и создаётся как Infinity
 * const huge = new Decimal('1e9000000000000001'); // Уже Infinity
 * averageDecimal(huge, huge); // throws InvalidOperandError (operand не finite)
 * ```
 */
export function averageDecimal(a: Decimal, b: Decimal): Decimal {
  // Создаём context безопасным способом
  const context = {
    operation: 'average',
    a: a && typeof a.toString === 'function' ? a.toString() : String(a),
    b: b && typeof b.toString === 'function' ? b.toString() : String(b),
  };

  // Валидация операндов
  assertFiniteOperands(a, b, context);

  // Выполняем операцию
  const sum = a.plus(b);
  const result = sum.dividedBy(MATH_CONSTANTS.TWO);

  // Проверка результата
  assertFiniteResult(result, { ...context, result: result.toString() });

  return result;
}
