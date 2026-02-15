/**
 * Типизированные причины ошибок Ratio
 *
 * @remarks
 * - Используется в RatioInvariantViolation.reason (Core)
 * - Используется в InvalidRatioError.context.reason (Facade)
 * - Позволяет exhaustive checking и безопасный рефакторинг
 * - Все значения SCREAMING_SNAKE_CASE
 *
 * @example
 * ```typescript
 * if (error.context.reason === RatioErrorReason.NAN) {
 *   console.log('Value was NaN');
 * }
 * ```
 */
export enum RatioErrorReason {
  /**
   * Значение NaN (Not a Number)
   *
   * @example
   * RatioService.fromDecimal(NaN) // reason: NAN
   */
  NAN = 'NAN',

  /**
   * Значение не конечно (Infinity или -Infinity)
   *
   * @example
   * RatioService.fromDecimal(Infinity) // reason: NON_FINITE
   */
  NON_FINITE = 'NON_FINITE',

  /**
   * Некорректный формат при парсинге
   *
   * @example
   * RatioFormatter.parse("not a number") // reason: INVALID_FORMAT
   */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /**
   * Некорректная структура JSON при десериализации
   *
   * @example
   * RatioSerializer.fromJSON({ wrong: "structure" }) // reason: INVALID_JSON_STRUCTURE
   */
  INVALID_JSON_STRUCTURE = 'INVALID_JSON_STRUCTURE',

  /**
   * Ratio меньше -1 когда требуется >= -1
   *
   * @remarks
   * Используется в ValidateRatioGteMinusOne для операций типа:
   * - amount * (1 + ratio) где (1 + ratio) должно быть >= 0
   *
   * @example
   * RatioService.fromDecimal(new Decimal(-1.5), { ensureGteMinusOne: true })
   * // reason: LESS_THAN_MINUS_ONE
   */
  LESS_THAN_MINUS_ONE = 'LESS_THAN_MINUS_ONE',

  /**
   * Ratio больше 1 когда требуется <= 1
   *
   * @remarks
   * Используется в ValidateRatioLteOne для операций типа:
   * - amount * (1 - ratio) где (1 - ratio) должно быть >= 0
   *
   * @example
   * RatioService.fromDecimal(new Decimal(1.5), { ensureLteOne: true })
   * // reason: GREATER_THAN_ONE
   */
  GREATER_THAN_ONE = 'GREATER_THAN_ONE',

  /**
   * Некорректное значение decimals (должно быть >= 0 и целое)
   *
   * @example
   * RatioFormatter.toPercent(ratio, -1) // reason: INVALID_DECIMALS
   */
  INVALID_DECIMALS = 'INVALID_DECIMALS',

  /**
   * Ошибка при операции с Decimal
   *
   * @example
   * Внутренняя ошибка при Decimal arithmetic
   */
  DECIMAL_ERROR = 'DECIMAL_ERROR'
}
