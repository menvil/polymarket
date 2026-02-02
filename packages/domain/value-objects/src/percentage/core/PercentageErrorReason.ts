/**
 * Enum для reason кодов ошибок Percentage
 *
 * @remarks
 * Используется в errorContext для структурированной обработки ошибок.
 * Позволяет клиентскому коду различать типы ошибок без парсинга строк.
 *
 * Аналогично MoneyErrorReason, PriceErrorReason, QuantityErrorReason.
 *
 * @example
 * ```typescript
 * if (error.context.reason === PercentageErrorReason.INVALID_FORMAT) {
 *   // обработка ошибки парсинга
 * }
 * ```
 */
export enum PercentageErrorReason {
  /**
   * Невалидный формат входных данных (не парсится в Decimal)
   */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /**
   * Значение NaN
   */
  NAN = 'NAN',

  /**
   * Значение не finite (Infinity, -Infinity)
   */
  NON_FINITE = 'NON_FINITE',

  /**
   * Значение < MIN_PERCENTAGE (-1e6)
   */
  OUT_OF_RANGE_LOW = 'OUT_OF_RANGE_LOW',

  /**
   * Значение > MAX_PERCENTAGE (1e6)
   */
  OUT_OF_RANGE_HIGH = 'OUT_OF_RANGE_HIGH',

  /**
   * Деление на ноль
   */
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO',

  /**
   * Отрицательная комиссия (для fee validation)
   */
  NEGATIVE_FEE = 'NEGATIVE_FEE',

  /**
   * Комиссия превышает максимум
   */
  EXCEEDS_MAX_FEE = 'EXCEEDS_MAX_FEE',

  /**
   * Суммарная комиссия превышает максимум
   */
  EXCEEDS_MAX_TOTAL_FEE = 'EXCEEDS_MAX_TOTAL_FEE',

  /**
   * Отрицательный спред
   */
  NEGATIVE_SPREAD = 'NEGATIVE_SPREAD',

  /**
   * Спред ниже минимума
   */
  BELOW_MIN_SPREAD = 'BELOW_MIN_SPREAD',

  /**
   * Спред превышает максимум
   */
  EXCEEDS_MAX_SPREAD = 'EXCEEDS_MAX_SPREAD'
}
