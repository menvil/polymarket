import Decimal from 'decimal.js';
import { assertFiniteOperand } from '../shared/index.js';

/**
 * Округляет Decimal к ближайшему целому (standard half-up rounding)
 *
 * @param value - Значение для округления
 * @returns Округлённое значение
 * @throws {InvalidOperandError} При невалидном операнде (NaN, ±Infinity)
 *
 * @remarks
 * Использует ROUND_HALF_UP - стандартное округление, где 0.5 всегда округляется вверх.
 * Это НЕ banker's rounding (ROUND_HALF_EVEN).
 *
 * Примеры округления 0.5:
 * - 2.5 -> 3 (вверх)
 * - 3.5 -> 4 (вверх)
 *
 * Для banker's rounding используйте value.toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).
 *
 * @example
 * ```typescript
 * roundDecimal(new Decimal(10.5)); // 11
 * roundDecimal(new Decimal(10.4)); // 10
 * roundDecimal(new Decimal(-10.5)); // -11
 *
 * // Невалидные значения
 * roundDecimal(new Decimal(NaN)); // throws InvalidOperandError
 * ```
 */
export function roundDecimal(value: Decimal): Decimal {
  const context = {
    operation: 'round',
    value: value.toString(),
  };

  assertFiniteOperand(value, 'value', context);

  return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/**
 * Округляет к нулю до ближайшего целого
 *
 * @param value - Значение для округления
 * @returns Округлённое значение
 * @throws {InvalidOperandError} При невалидном операнде (NaN, ±Infinity)
 *
 * @remarks
 *
 * Использует ROUND_DOWN - округление к нулю.
 * Для положительных чисел это математический floor, для отрицательных - ceil.
 *
 * Для математического floor (всегда к -Infinity) используйте mathFloorDecimal.
 *
 * Примеры:
 * - 10.9 -> 10 (к нулю)
 * - -10.9 -> -10 (к нулю, НЕ к -Infinity!)
 *
 * @example
 * ```typescript
 * roundTowardZeroDecimal(new Decimal(10.9)); // 10
 * roundTowardZeroDecimal(new Decimal(-10.9)); // -10 (к нулю, не к -Infinity!)
 *
 * // Сравнение с математическим floor:
 * roundTowardZeroDecimal(new Decimal(-10.1)); // -10 (к нулю)
 * mathFloorDecimal(new Decimal(-10.1)); // -11 (к -Infinity)
 * ```
 */
export function roundTowardZeroDecimal(value: Decimal): Decimal {
  const context = {
    operation: 'roundTowardZero',
    value: value.toString(),
  };

  assertFiniteOperand(value, 'value', context);

  return value.toDecimalPlaces(0, Decimal.ROUND_DOWN);
}

/**
 * Округляет от нуля до ближайшего целого
 *
 * @param value - Значение для округления
 * @returns Округлённое значение
 * @throws {InvalidOperandError} При невалидном операнде (NaN, ±Infinity)
 *
 * @remarks
 *
 * Использует ROUND_UP - округление от нуля.
 * Для положительных чисел это математический ceil, для отрицательных - floor.
 *
 * Для математического ceil (всегда к +Infinity) используйте mathCeilDecimal.
 *
 * Примеры:
 * - 10.1 -> 11 (от нуля)
 * - -10.1 -> -11 (от нуля, НЕ к +Infinity!)
 *
 * @example
 * ```typescript
 * roundAwayFromZeroDecimal(new Decimal(10.1)); // 11
 * roundAwayFromZeroDecimal(new Decimal(-10.1)); // -11 (от нуля, не к +Infinity!)
 *
 * // Сравнение с математическим ceil:
 * roundAwayFromZeroDecimal(new Decimal(-10.9)); // -11 (от нуля)
 * mathCeilDecimal(new Decimal(-10.9)); // -10 (к +Infinity)
 * ```
 */
export function roundAwayFromZeroDecimal(value: Decimal): Decimal {
  const context = {
    operation: 'roundAwayFromZero',
    value: value.toString(),
  };

  assertFiniteOperand(value, 'value', context);

  return value.toDecimalPlaces(0, Decimal.ROUND_UP);
}

/**
 * Усекает до целого (отбрасывает дробную часть)
 *
 * @param value - Значение для усечения
 * @returns Целая часть числа
 * @throws {InvalidOperandError} При невалидном операнде (NaN, ±Infinity)
 *
 * @remarks
 * Эквивалентно округлению к нулю (truncation).
 * Для отрицательных отличается от математического floor.
 *
 * Примеры отличия от floor:
 * - trunc(-10.9) = -10 (к нулю)
 * - floor(-10.9) = -11 (к -Infinity)
 *
 * Использует встроенный метод .trunc() из Decimal.js.
 *
 * @example
 * ```typescript
 * truncDecimal(new Decimal(10.9)); // 10 (к нулю)
 * truncDecimal(new Decimal(-10.9)); // -10 (к нулю, отличается от floor!)
 * ```
 */
export function truncDecimal(value: Decimal): Decimal {
  const context = {
    operation: 'trunc',
    value: value.toString(),
  };

  assertFiniteOperand(value, 'value', context);

  return value.trunc();
}

/**
 * Математический floor - округление к -Infinity
 *
 * @param value - Значение для округления
 * @returns Округлённое значение
 * @throws {InvalidOperandError} При невалидном операнде (NaN, ±Infinity)
 *
 * @remarks
 * Использует ROUND_FLOOR - всегда округление к -Infinity.
 *
 * В отличие от roundTowardZeroDecimal (ROUND_DOWN), всегда округляет вниз,
 * независимо от знака числа.
 *
 * Примеры:
 * - 10.9 -> 10 (к -Infinity)
 * - -10.1 -> -11 (к -Infinity)
 *
 * @example
 * ```typescript
 * mathFloorDecimal(new Decimal(10.9)); // 10
 * mathFloorDecimal(new Decimal(-10.1)); // -11 (к -Infinity)
 *
 * // Сравнение с roundTowardZeroDecimal (ROUND_DOWN):
 * roundTowardZeroDecimal(new Decimal(-10.1)); // -10 (к нулю)
 * mathFloorDecimal(new Decimal(-10.1)); // -11 (к -Infinity)
 * ```
 */
export function mathFloorDecimal(value: Decimal): Decimal {
  const context = {
    operation: 'mathFloor',
    value: value.toString(),
  };

  assertFiniteOperand(value, 'value', context);

  return value.toDecimalPlaces(0, Decimal.ROUND_FLOOR);
}

/**
 * Математический ceil - округление к +Infinity
 *
 * @param value - Значение для округления
 * @returns Округлённое значение
 * @throws {InvalidOperandError} При невалидном операнде (NaN, ±Infinity)
 *
 * @remarks
 * Использует ROUND_CEIL - всегда округление к +Infinity.
 *
 * В отличие от roundAwayFromZeroDecimal (ROUND_UP), всегда округляет вверх,
 * независимо от знака числа.
 *
 * Примеры:
 * - 10.1 -> 11 (к +Infinity)
 * - -10.9 -> -10 (к +Infinity)
 *
 * @example
 * ```typescript
 * mathCeilDecimal(new Decimal(10.1)); // 11
 * mathCeilDecimal(new Decimal(-10.9)); // -10 (к +Infinity)
 *
 * // Сравнение с roundAwayFromZeroDecimal (ROUND_UP):
 * roundAwayFromZeroDecimal(new Decimal(-10.9)); // -11 (от нуля)
 * mathCeilDecimal(new Decimal(-10.9)); // -10 (к +Infinity)
 * ```
 */
export function mathCeilDecimal(value: Decimal): Decimal {
  const context = {
    operation: 'mathCeil',
    value: value.toString(),
  };

  assertFiniteOperand(value, 'value', context);

  return value.toDecimalPlaces(0, Decimal.ROUND_CEIL);
}
