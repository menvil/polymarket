/**
 * Типизированные причины ошибок для SignedQuantity операций
 *
 * @remarks
 * Используется в InvalidSignedQuantityError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 *
 * @example
 * ```typescript
 * import { SignedQuantityErrorReason } from '@polymarket/value-objects/signed-quantity';
 *
 * if (result.error.context?.reason === SignedQuantityErrorReason.NAN) {
 *   console.error('SignedQuantity cannot be NaN');
 * }
 * ```
 */
export enum SignedQuantityErrorReason {
  /**
   * Значение NaN
   */
  NAN = 'NAN',

  /**
   * Значение не finite (Infinity, -Infinity)
   */
  NON_FINITE = 'NON_FINITE',

  /**
   * Ошибка парсинга значения
   *
   * @remarks
   * Возникает при конвертации string/number в Decimal.
   * Обычно содержит context.raw с невалидным значением.
   */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /**
   * Деление на ноль
   */
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO'
}
