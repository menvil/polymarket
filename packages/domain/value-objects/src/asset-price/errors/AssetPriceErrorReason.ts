/**
 * Типизированные причины ошибок AssetPrice.
 *
 * @remarks
 * - Используется в `AssetPriceInvariantViolation.reason` (Core)
 * - Используется в `InvalidAssetPriceError.context.reason` (Facade)
 * - Позволяет exhaustive checking и безопасный рефакторинг
 * - Все значения SCREAMING_SNAKE_CASE
 *
 * @example
 * ```typescript
 * if (error.context.reason === AssetPriceErrorReason.NOT_POSITIVE) {
 *   console.log('Reference price was zero or negative');
 * }
 * ```
 */
export enum AssetPriceErrorReason {
  /**
   * Значение NaN (Not a Number)
   *
   * @example
   * AssetPriceService.create(NaN) // reason: NAN
   */
  NAN = 'NAN',

  /**
   * Значение не конечно (Infinity или -Infinity)
   *
   * @example
   * AssetPriceService.create(Infinity) // reason: NON_FINITE
   */
  NON_FINITE = 'NON_FINITE',

  /**
   * Значение не положительно (`<= 0`)
   *
   * @remarks
   * Единственная доменная граница AssetPrice: цена актива существует
   * только как положительная величина. Верхней границы НЕТ — в отличие от
   * `Price` рынка предсказаний.
   *
   * @example
   * AssetPriceService.create('0') // reason: NOT_POSITIVE
   */
  NOT_POSITIVE = 'NOT_POSITIVE',

  /**
   * Некорректный формат при парсинге
   *
   * @example
   * AssetPriceService.create('not a number') // reason: INVALID_FORMAT
   */
  INVALID_FORMAT = 'INVALID_FORMAT',
}
