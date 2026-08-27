/**
 * Типизированные причины ошибок ReferencePrice.
 *
 * @remarks
 * - Используется в `ReferencePriceInvariantViolation.reason` (Core)
 * - Используется в `InvalidReferencePriceError.context.reason` (Facade)
 * - Позволяет exhaustive checking и безопасный рефакторинг
 * - Все значения SCREAMING_SNAKE_CASE
 *
 * @example
 * ```typescript
 * if (error.context.reason === ReferencePriceErrorReason.NOT_POSITIVE) {
 *   console.log('Reference price was zero or negative');
 * }
 * ```
 */
export enum ReferencePriceErrorReason {
  /**
   * Значение NaN (Not a Number)
   *
   * @example
   * ReferencePriceService.create(NaN) // reason: NAN
   */
  NAN = 'NAN',

  /**
   * Значение не конечно (Infinity или -Infinity)
   *
   * @example
   * ReferencePriceService.create(Infinity) // reason: NON_FINITE
   */
  NON_FINITE = 'NON_FINITE',

  /**
   * Значение не положительно (`<= 0`)
   *
   * @remarks
   * Единственная доменная граница ReferencePrice: цена актива существует
   * только как положительная величина. Верхней границы НЕТ — в отличие от
   * `Price` рынка предсказаний.
   *
   * @example
   * ReferencePriceService.create('0') // reason: NOT_POSITIVE
   */
  NOT_POSITIVE = 'NOT_POSITIVE',

  /**
   * Некорректный формат при парсинге
   *
   * @example
   * ReferencePriceService.create('not a number') // reason: INVALID_FORMAT
   */
  INVALID_FORMAT = 'INVALID_FORMAT',
}
