/**
 * Типизированные причины ошибок для Price операций
 *
 * @remarks
 * Используется в InvalidPriceError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 *
 * @example
 * ```typescript
 * import { PriceErrorReason } from '@polymarket/value-objects/price';
 *
 * if (result.error.context?.reason === PriceErrorReason.NOT_ALIGNED) {
 *   console.error('Price not aligned to tick size');
 * }
 * ```
 */
export enum PriceErrorReason {
  /** Значение NaN */
  NAN = 'NAN',

  /** Значение не finite (Infinity, -Infinity) */
  NON_FINITE = 'NON_FINITE',

  /** Цена превышает максимальное значение */
  EXCEEDS_MAX_PRICE = 'EXCEEDS_MAX_PRICE',

  /** Цена меньше минимального значения */
  NEGATIVE_PRICE = 'NEGATIVE_PRICE',

  /** Деление на ноль */
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO',

  /** Ошибка парсинга значения */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /** Цена не выровнена по tickSize */
  NOT_ALIGNED = 'NOT_ALIGNED',

  /** Невалидный tickSize */
  INVALID_TICK_SIZE = 'INVALID_TICK_SIZE',

  /** Цена вне допустимого диапазона (низкая) */
  OUT_OF_RANGE_LOW = 'OUT_OF_RANGE_LOW',

  /** Цена вне допустимого диапазона (высокая) */
  OUT_OF_RANGE_HIGH = 'OUT_OF_RANGE_HIGH'
}
