/**
 * Типизированные причины ошибок операций Fee
 *
 * @remarks
 * Используется в FeeOperationError.context.reason для идентификации типа ошибки операции.
 * Отличается от FeeErrorReason (validation errors) - это domain rule violations.
 */
export var FeeOperationErrorReason;
(function (FeeOperationErrorReason) {
    /**
     * Попытка сложить fees с разными assets
     */
    FeeOperationErrorReason["ASSET_MISMATCH"] = "ASSET_MISMATCH";
    /**
     * Неожиданная ошибка при выполнении операции
     *
     * @remarks
     * Используется для wrap неожиданных ошибок (не FeeOperationError)
     * которые возникают при выполнении операций.
     */
    FeeOperationErrorReason["UNEXPECTED_ERROR"] = "UNEXPECTED_ERROR";
})(FeeOperationErrorReason || (FeeOperationErrorReason = {}));
//# sourceMappingURL=FeeOperationErrorReason.js.map