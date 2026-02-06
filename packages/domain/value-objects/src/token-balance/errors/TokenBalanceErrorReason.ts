/**
 * Типизированные причины ошибок TokenBalance
 *
 * @remarks
 * Используется в InvalidTokenBalanceError.context.reason для type-safe обработки ошибок.
 *
 * @example
 * ```typescript
 * const result = TokenBalanceService.create(token, qty);
 * if (!result.ok) {
 *   if (result.error.context?.reason === TokenBalanceErrorReason.INVALID_TOKEN) {
 *     console.error('Token is invalid');
 *   }
 * }
 * ```
 */
export enum TokenBalanceErrorReason {
  /**
   * OutcomeToken некорректен
   */
  INVALID_TOKEN = 'INVALID_TOKEN',

  /**
   * Quantity некорректно (negative, NaN, Infinity)
   */
  INVALID_AMOUNT = 'INVALID_AMOUNT',

  /**
   * Общая ошибка валидации при создании
   */
  INVALID_INPUT = 'INVALID_INPUT',

  /**
   * Некорректный формат JSON при десериализации
   */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /**
   * Математическая операция невозможна (например, вычитание больше чем есть)
   */
  INVALID_OPERATION = 'INVALID_OPERATION',
}
