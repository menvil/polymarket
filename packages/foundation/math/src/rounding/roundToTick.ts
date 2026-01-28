import Decimal from 'decimal.js';
import { InvalidTickSizeError } from '@polymarket/errors';

/**
 * Округляет значение до размера тика
 *
 * @param value - Значение для округления
 * @param tickSize - Размер тика (например, 0.01 для центов)
 * @param roundingMode - Режим округления Decimal (default: ROUND_HALF_UP)
 * @returns Округлённое значение
 * @throws {InvalidTickSizeError} Если tickSize невалидный (<= 0 или не finite)
 *
 * @remarks
 * Алгоритм (полностью на Decimal API):
 * 1. value / tickSize (получаем количество тиков как Decimal)
 * 2. toDecimalPlaces(0, roundingMode) (округляем до целого числа тиков)
 * 3. * tickSize (умножаем обратно)
 *
 * Использует ТОЛЬКО Decimal API - нет конвертации в number и обратно.
 * Это сохраняет точность для больших чисел.
 *
 * Режимы округления:
 * - Decimal.ROUND_HALF_UP (default) - округление к ближайшему, .5 вверх
 * - Decimal.ROUND_DOWN - округление к нулю (floor для положительных)
 * - Decimal.ROUND_UP - округление от нуля (ceil для положительных)
 * - Decimal.ROUND_FLOOR - округление вниз (к -Infinity)
 * - Decimal.ROUND_CEIL - округление вверх (к +Infinity)
 *
 * @example
 * ```typescript
 * // Округление до 0.01 (центы) - default ROUND_HALF_UP
 * roundToTick(new Decimal(10.567), new Decimal(0.01)); // 10.57
 * roundToTick(new Decimal(10.564), new Decimal(0.01)); // 10.56
 * roundToTick(new Decimal(10.565), new Decimal(0.01)); // 10.57 (.5 вверх)
 *
 * // Округление до 0.1
 * roundToTick(new Decimal(10.567), new Decimal(0.1)); // 10.6
 *
 * // Округление вниз (ROUND_DOWN)
 * roundToTick(new Decimal(10.567), new Decimal(0.01), Decimal.ROUND_DOWN); // 10.56
 *
 * // Округление вверх (ROUND_UP)
 * roundToTick(new Decimal(10.561), new Decimal(0.01), Decimal.ROUND_UP); // 10.57
 *
 * // Работает с большими числами без потери точности
 * roundToTick(new Decimal('999999999999.567'), new Decimal(0.01)); // 999999999999.57
 * ```
 */
export function roundToTick(
  value: Decimal,
  tickSize: Decimal,
  roundingMode: Decimal.Rounding = Decimal.ROUND_HALF_UP
): Decimal {
  // Валидация tickSize
  if (!tickSize.isFinite() || tickSize.lessThanOrEqualTo(0)) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be finite and positive, got ${ctx.tickSize}`,
      {
        context: {
          tickSize: tickSize.toString(),
          value: value.toString(),
        },
      }
    );
  }

  // Алгоритм округления до тика (полностью на Decimal)
  const divided = value.dividedBy(tickSize);
  const rounded = divided.toDecimalPlaces(0, roundingMode);
  const result = rounded.times(tickSize);

  return result;
}

/**
 * Округляет вниз до тика (к нулю для положительных, от нуля для отрицательных)
 *
 * @param value - Значение для округления
 * @param tickSize - Размер тика
 * @returns Округлённое значение
 *
 * @remarks
 * Использует Decimal.ROUND_DOWN - округление к нулю.
 * Для положительных чисел это floor, для отрицательных - ceil.
 *
 * @example
 * ```typescript
 * floorToTick(new Decimal(10.567), new Decimal(0.01)); // 10.56
 * floorToTick(new Decimal(-10.567), new Decimal(0.01)); // -10.56 (к нулю)
 * ```
 */
export function floorToTick(value: Decimal, tickSize: Decimal): Decimal {
  return roundToTick(value, tickSize, Decimal.ROUND_DOWN);
}

/**
 * Округляет вверх до тика (от нуля)
 *
 * @param value - Значение для округления
 * @param tickSize - Размер тика
 * @returns Округлённое значение
 *
 * @remarks
 * Использует Decimal.ROUND_UP - округление от нуля.
 * Для положительных чисел это ceil, для отрицательных - floor.
 *
 * @example
 * ```typescript
 * ceilToTick(new Decimal(10.561), new Decimal(0.01)); // 10.57
 * ceilToTick(new Decimal(-10.561), new Decimal(0.01)); // -10.57 (от нуля)
 * ```
 */
export function ceilToTick(value: Decimal, tickSize: Decimal): Decimal {
  return roundToTick(value, tickSize, Decimal.ROUND_UP);
}

/**
 * Округляет до тика с математическим floor (всегда вниз к -Infinity)
 *
 * @param value - Значение для округления
 * @param tickSize - Размер тика
 * @returns Округлённое значение
 *
 * @remarks
 * Использует Decimal.ROUND_FLOOR - всегда округление вниз.
 * В отличие от floorToTick, всегда округляет к -Infinity.
 *
 * @example
 * ```typescript
 * mathFloorToTick(new Decimal(10.567), new Decimal(0.01)); // 10.56
 * mathFloorToTick(new Decimal(-10.561), new Decimal(0.01)); // -10.57 (к -Infinity)
 * ```
 */
export function mathFloorToTick(value: Decimal, tickSize: Decimal): Decimal {
  return roundToTick(value, tickSize, Decimal.ROUND_FLOOR);
}

/**
 * Округляет до тика с математическим ceil (всегда вверх к +Infinity)
 *
 * @param value - Значение для округления
 * @param tickSize - Размер тика
 * @returns Округлённое значение
 *
 * @remarks
 * Использует Decimal.ROUND_CEIL - всегда округление вверх.
 * В отличие от ceilToTick, всегда округляет к +Infinity.
 *
 * @example
 * ```typescript
 * mathCeilToTick(new Decimal(10.561), new Decimal(0.01)); // 10.57
 * mathCeilToTick(new Decimal(-10.567), new Decimal(0.01)); // -10.56 (к +Infinity)
 * ```
 */
export function mathCeilToTick(value: Decimal, tickSize: Decimal): Decimal {
  return roundToTick(value, tickSize, Decimal.ROUND_CEIL);
}
