import Decimal from 'decimal.js';
import {
  assertFiniteOperand,
  assertValidDecimalPlaces,
  assertValidRoundingMode,
} from '../shared/index.js';

/**
 * Округляет значение до указанного количества десятичных знаков
 *
 * @param value - Значение для округления
 * @param decimalPlaces - Количество десятичных знаков (0 для целых чисел, максимум 1e9)
 * @param roundingMode - Режим округления Decimal (0-8)
 * @returns Округлённое значение
 * @throws {InvalidOperandError} При невалидном value (NaN, ±Infinity)
 * @throws {InvalidDecimalPlacesError} При невалидном количестве знаков (не finite, не integer, отрицательное, больше 1e9)
 * @throws {InvalidRoundingModeError} При невалидном roundingMode (не integer, вне диапазона 0-8)
 *
 * @remarks
 * Обёртка над Decimal.toDecimalPlaces() с валидацией для единообразного API.
 *
 * Ограничения:
 * - decimalPlaces должно быть в диапазоне [0, 1e9]
 * - roundingMode должен быть в диапазоне [0, 8]
 * - Превышение максимума decimalPlaces вызывает InvalidDecimalPlacesError
 * - Невалидный roundingMode вызывает Error от Decimal.js
 *
 * Режимы округления:
 * - 0 (Decimal.ROUND_UP) - округление от нуля
 * - 1 (Decimal.ROUND_DOWN) - округление к нулю
 * - 2 (Decimal.ROUND_CEIL) - округление к +Infinity
 * - 3 (Decimal.ROUND_FLOOR) - округление к -Infinity
 * - 4 (Decimal.ROUND_HALF_UP) - округление к ближайшему, .5 вверх
 * - 5 (Decimal.ROUND_HALF_DOWN) - округление к ближайшему, .5 вниз
 * - 6 (Decimal.ROUND_HALF_EVEN) - округление к ближайшему, .5 к чётному
 * - 7 (Decimal.ROUND_HALF_CEIL) - округление к ближайшему, .5 к +Infinity
 * - 8 (Decimal.ROUND_HALF_FLOOR) - округление к ближайшему, .5 к -Infinity
 *
 * @example
 * ```typescript
 * // Округление до 2 знаков (центы) - ROUND_HALF_UP
 * roundToPrecision(new Decimal('10.567'), 2, Decimal.ROUND_HALF_UP); // 10.57
 * roundToPrecision(new Decimal('10.564'), 2, Decimal.ROUND_HALF_UP); // 10.56
 * roundToPrecision(new Decimal('10.565'), 2, Decimal.ROUND_HALF_UP); // 10.57 (.5 вверх)
 *
 * // Округление до целого
 * roundToPrecision(new Decimal('10.5'), 0, Decimal.ROUND_HALF_UP); // 11
 *
 * // Округление до 1 знака
 * roundToPrecision(new Decimal('10.567'), 1, Decimal.ROUND_HALF_UP); // 10.6
 *
 * // Округление вниз (ROUND_DOWN)
 * roundToPrecision(new Decimal('10.567'), 2, Decimal.ROUND_DOWN); // 10.56
 *
 * // Округление вверх (ROUND_UP)
 * roundToPrecision(new Decimal('10.561'), 2, Decimal.ROUND_UP); // 10.57
 *
 * // Работает с большими числами без потери точности
 * roundToPrecision(new Decimal('999999999999.567'), 2, Decimal.ROUND_HALF_UP); // 999999999999.57
 *
 * // Работает с отрицательными числами
 * roundToPrecision(new Decimal('-10.567'), 2, Decimal.ROUND_HALF_UP); // -10.57
 *
 * // Невалидные значения бросают InvalidDecimalPlacesError
 * roundToPrecision(new Decimal('10.567'), -1, Decimal.ROUND_HALF_UP); // throws
 * roundToPrecision(new Decimal('10.567'), NaN, Decimal.ROUND_HALF_UP); // throws
 * roundToPrecision(new Decimal('10.567'), 1.5, Decimal.ROUND_HALF_UP); // throws
 * roundToPrecision(new Decimal('10.567'), 1e9 + 1, Decimal.ROUND_HALF_UP); // throws (превышен максимум)
 * ```
 */
export function roundToPrecision(
  value: Decimal,
  decimalPlaces: number,
  roundingMode: Decimal.Rounding
): Decimal {
  const context = {
    operation: 'roundToPrecision',
    value: value.toString(),
    decimalPlaces: String(decimalPlaces),
    roundingMode: String(roundingMode),
  };

  // Валидация через shared assertions
  assertFiniteOperand(value, 'value', context);
  assertValidDecimalPlaces(decimalPlaces, context);
  assertValidRoundingMode(roundingMode, context);

  // Выполняем округление
  return value.toDecimalPlaces(decimalPlaces, roundingMode);
}
