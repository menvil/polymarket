import Decimal from 'decimal.js';

/**
 * Округляет Decimal к ближайшему целому (standard half-up rounding)
 *
 * @param value - Значение для округления
 * @returns Округлённое значение
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
 * ```
 */
export function roundDecimal(value: Decimal): Decimal {
  return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/**
 * Округляет вниз к ближайшему целому (к нулю)
 *
 * @param value - Значение для округления
 * @returns Округлённое значение
 *
 * @remarks
 * Использует ROUND_DOWN - округление к нулю.
 * Для положительных чисел это floor, для отрицательных - ceil.
 *
 * Примеры:
 * - 10.9 -> 10 (к нулю)
 * - -10.9 -> -10 (к нулю)
 *
 * @example
 * ```typescript
 * floorDecimal(new Decimal(10.9)); // 10
 * floorDecimal(new Decimal(-10.9)); // -10
 * ```
 */
export function floorDecimal(value: Decimal): Decimal {
  return value.toDecimalPlaces(0, Decimal.ROUND_DOWN);
}

/**
 * Округляет вверх к ближайшему целому (от нуля)
 *
 * @param value - Значение для округления
 * @returns Округлённое значение
 *
 * @remarks
 * Использует ROUND_UP - округление от нуля.
 * Для положительных чисел это ceil, для отрицательных - floor.
 *
 * Примеры:
 * - 10.1 -> 11 (от нуля)
 * - -10.1 -> -11 (от нуля)
 *
 * @example
 * ```typescript
 * ceilDecimal(new Decimal(10.1)); // 11
 * ceilDecimal(new Decimal(-10.1)); // -11
 * ```
 */
export function ceilDecimal(value: Decimal): Decimal {
  return value.toDecimalPlaces(0, Decimal.ROUND_UP);
}

/**
 * Усекает до целого (отбрасывает дробную часть)
 *
 * @param value - Значение для усечения
 * @returns Целая часть числа
 *
 * @remarks
 * Эквивалентно floorDecimal - отбрасывает дробную часть.
 * Использует встроенный метод .trunc() из Decimal.js.
 *
 * @example
 * ```typescript
 * truncDecimal(new Decimal(10.9)); // 10
 * truncDecimal(new Decimal(-10.9)); // -10
 * ```
 */
export function truncDecimal(value: Decimal): Decimal {
  return value.trunc();
}
