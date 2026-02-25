/**
 * Типизированные причины ошибок Fee
 *
 * @remarks
 * Используется в ValidationError.context.reason для идентификации типа ошибки.
 */
export enum FeeErrorReason {
  /**
   * Попытка сложить fees с разными assets
   */
  ASSET_MISMATCH = 'ASSET_MISMATCH',

  /**
   * Отрицательная комиссия (не допускается)
   */
  NEGATIVE_FEE = 'NEGATIVE_FEE',

  /**
   * Невалидный AssetQuantity
   */
  INVALID_QUANTITY = 'INVALID_QUANTITY',
}
