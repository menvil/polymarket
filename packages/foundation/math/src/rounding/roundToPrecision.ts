import Decimal from 'decimal.js';
import { InvalidDecimalPlacesError } from '@polymarket/errors';

/**
 * Округляет значение до указанного количества десятичных знаков
 *
 * @param value - Значение для округления
 * @param decimalPlaces - Количество десятичных знаков (0 для целых чисел)
 * @param roundingMode - Режим округления Decimal
 * @returns Округлённое значение
 * @throws {InvalidDecimalPlacesError} При невалидном количестве знаков (отрицательное, NaN, Infinity, не integer)
 *
 * @remarks
 * Обёртка над Decimal.toDecimalPlaces() с валидацией для единообразного API.
 *
 * Режимы округления:
 * - Decimal.ROUND_HALF_UP - округление к ближайшему, .5 вверх
 * - Decimal.ROUND_DOWN - округление к нулю
 * - Decimal.ROUND_UP - округление от нуля
 * - Decimal.ROUND_FLOOR - округление к -Infinity
 * - Decimal.ROUND_CEIL - округление к +Infinity
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
 * ```
 */
export function roundToPrecision(
  value: Decimal,
  decimalPlaces: number,
  roundingMode: Decimal.Rounding
): Decimal {
  // Валидация decimalPlaces через Decimal
  const decimalPlacesDecimal = new Decimal(decimalPlaces);

  if (!decimalPlacesDecimal.isFinite() || decimalPlacesDecimal.isNegative() || !decimalPlacesDecimal.isInteger()) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be a non-negative integer, got ${ctx.decimalPlaces}`,
      {
        context: {
          decimalPlaces: decimalPlacesDecimal.toString(),
          value: value.toString(),
          operation: 'roundToPrecision'
        }
      }
    );
  }

  return value.toDecimalPlaces(decimalPlaces, roundingMode);
}
