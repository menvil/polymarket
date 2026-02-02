/**
 * Типизированные причины ошибок для Quantity операций
 *
 * @remarks
 * Используется в InvalidQuantityError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 *
 * @example
 * ```typescript
 * import { QuantityErrorReason } from '@polymarket/value-objects/quantity';
 *
 * if (result.error.context?.reason === QuantityErrorReason.NEGATIVE_QUANTITY) {
 *   console.error('Quantity cannot be negative');
 * }
 * ```
 */
export enum QuantityErrorReason {
  /** Значение NaN */
  NAN = 'NAN',

  /** Значение не finite (Infinity, -Infinity) */
  NON_FINITE = 'NON_FINITE',

  /** Количество превышает максимальное значение */
  EXCEEDS_MAX_QUANTITY = 'EXCEEDS_MAX_QUANTITY',

  /** Количество отрицательное */
  NEGATIVE_QUANTITY = 'NEGATIVE_QUANTITY',

  /** Деление на ноль */
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO',

  /** Ошибка парсинга значения */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /** Невалидный stepSize */
  INVALID_STEP_SIZE = 'INVALID_STEP_SIZE',

  /** Результат операции отрицательный (для subtract) */
  NEGATIVE = 'NEGATIVE'
}
