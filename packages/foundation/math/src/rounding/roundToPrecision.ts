import Decimal from 'decimal.js';
import {
  InvalidDecimalPlacesError,
  InvalidOperandError,
  InvalidRoundingModeError,
} from '@polymarket/errors';

/**
 * Максимально допустимое количество десятичных знаков
 *
 * @remarks
 * Ограничение Decimal.js для toDecimalPlaces().
 * Значения больше этого вызывают внутреннюю ошибку библиотеки.
 */
const MAX_DECIMAL_PLACES = 1e9;

/**
 * Минимальный допустимый режим округления Decimal.js
 */
const MIN_ROUNDING_MODE = 0;

/**
 * Максимальный допустимый режим округления Decimal.js
 */
const MAX_ROUNDING_MODE = 8;

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
  const operation = 'roundToPrecision';

  // Валидация value
  if (!value.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Value must be finite, got ${ctx.value}`,
      {
        context: {
          value: value.toString(),
          decimalPlaces: String(decimalPlaces),
          roundingMode: String(roundingMode),
          operation,
        },
      }
    );
  }

  // Валидация decimalPlaces как number (без new Decimal)
  if (!Number.isFinite(decimalPlaces)) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be a finite number, got ${ctx.decimalPlaces}`,
      {
        context: {
          decimalPlaces: String(decimalPlaces),
          value: value.toString(),
          operation,
        },
      }
    );
  }

  if (!Number.isInteger(decimalPlaces)) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be an integer, got ${ctx.decimalPlaces}`,
      {
        context: {
          decimalPlaces: String(decimalPlaces),
          value: value.toString(),
          operation,
        },
      }
    );
  }

  if (decimalPlaces < 0) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be non-negative, got ${ctx.decimalPlaces}`,
      {
        context: {
          decimalPlaces: String(decimalPlaces),
          value: value.toString(),
          operation,
        },
      }
    );
  }

  if (decimalPlaces > MAX_DECIMAL_PLACES) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must not exceed ${ctx.max}, got ${ctx.decimalPlaces}`,
      {
        context: {
          decimalPlaces: String(decimalPlaces),
          max: String(MAX_DECIMAL_PLACES),
          value: value.toString(),
          operation,
        },
      }
    );
  }

  // Валидация roundingMode
  if (!Number.isInteger(roundingMode)) {
    throw new InvalidRoundingModeError(
      (ctx) => `Rounding mode must be an integer, got ${ctx.roundingMode}`,
      {
        context: {
          roundingMode: String(roundingMode),
          value: value.toString(),
          decimalPlaces: String(decimalPlaces),
          operation,
        },
      }
    );
  }

  if (roundingMode < MIN_ROUNDING_MODE || roundingMode > MAX_ROUNDING_MODE) {
    throw new InvalidRoundingModeError(
      (ctx) =>
        `Rounding mode must be between ${ctx.min} and ${ctx.max}, got ${ctx.roundingMode}`,
      {
        context: {
          roundingMode: String(roundingMode),
          min: String(MIN_ROUNDING_MODE),
          max: String(MAX_ROUNDING_MODE),
          value: value.toString(),
          decimalPlaces: String(decimalPlaces),
          operation,
        },
      }
    );
  }

  // Выполняем округление
  return value.toDecimalPlaces(decimalPlaces, roundingMode);
}
