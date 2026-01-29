import Decimal from 'decimal.js';
import { InvalidOperandError } from '@polymarket/errors';

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
  if (!value.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Value must be finite, got ${ctx.value}`,
      {
        context: {
          value: value.toString(),
          operation: 'round',
        },
      }
    );
  }

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
 * ВНИМАНИЕ: Название "floor" вводит в заблуждение!
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
 * floorDecimal(new Decimal(10.9)); // 10
 * floorDecimal(new Decimal(-10.9)); // -10 (к нулю, не к -Infinity!)
 *
 * // Сравнение с математическим floor:
 * floorDecimal(new Decimal(-10.1)); // -10 (к нулю)
 * mathFloorDecimal(new Decimal(-10.1)); // -11 (к -Infinity)
 * ```
 */
export function floorDecimal(value: Decimal): Decimal {
  if (!value.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Value must be finite, got ${ctx.value}`,
      {
        context: {
          value: value.toString(),
          operation: 'floor',
        },
      }
    );
  }

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
 * ВНИМАНИЕ: Название "ceil" вводит в заблуждение!
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
 * ceilDecimal(new Decimal(10.1)); // 11
 * ceilDecimal(new Decimal(-10.1)); // -11 (от нуля, не к +Infinity!)
 *
 * // Сравнение с математическим ceil:
 * ceilDecimal(new Decimal(-10.9)); // -11 (от нуля)
 * mathCeilDecimal(new Decimal(-10.9)); // -10 (к +Infinity)
 * ```
 */
export function ceilDecimal(value: Decimal): Decimal {
  if (!value.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Value must be finite, got ${ctx.value}`,
      {
        context: {
          value: value.toString(),
          operation: 'ceil',
        },
      }
    );
  }

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
  if (!value.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Value must be finite, got ${ctx.value}`,
      {
        context: {
          value: value.toString(),
          operation: 'trunc',
        },
      }
    );
  }

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
 * В отличие от floorDecimal (ROUND_DOWN), всегда округляет вниз,
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
 * // Сравнение с floorDecimal (ROUND_DOWN):
 * floorDecimal(new Decimal(-10.1)); // -10 (к нулю)
 * mathFloorDecimal(new Decimal(-10.1)); // -11 (к -Infinity)
 * ```
 */
export function mathFloorDecimal(value: Decimal): Decimal {
  if (!value.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Value must be finite, got ${ctx.value}`,
      {
        context: {
          value: value.toString(),
          operation: 'mathFloor',
        },
      }
    );
  }

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
 * В отличие от ceilDecimal (ROUND_UP), всегда округляет вверх,
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
 * // Сравнение с ceilDecimal (ROUND_UP):
 * ceilDecimal(new Decimal(-10.9)); // -11 (от нуля)
 * mathCeilDecimal(new Decimal(-10.9)); // -10 (к +Infinity)
 * ```
 */
export function mathCeilDecimal(value: Decimal): Decimal {
  if (!value.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Value must be finite, got ${ctx.value}`,
      {
        context: {
          value: value.toString(),
          operation: 'mathCeil',
        },
      }
    );
  }

  return value.toDecimalPlaces(0, Decimal.ROUND_CEIL);
}
