/**
 * Типизированные причины ошибок операций Fee
 *
 * @remarks
 * Используется в FeeOperationError.context.reason для идентификации типа ошибки операции.
 * Отличается от FeeErrorReason (validation errors) - это domain rule violations.
 */
export enum FeeOperationErrorReason {
  /**
   * Попытка сложить fees с разными assets
   */
  ASSET_MISMATCH = 'ASSET_MISMATCH',
}
