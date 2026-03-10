/**
 * Типизированные причины ошибок Fee
 *
 * @remarks
 * Используется в ValidationError.context.reason для идентификации типа ошибки.
 */
export declare enum FeeErrorReason {
    /**
     * Отрицательная комиссия (не допускается)
     */
    NEGATIVE_FEE = "NEGATIVE_FEE",
    /**
     * Невалидный AssetQuantity или amount
     */
    INVALID_QUANTITY = "INVALID_QUANTITY",
    /**
     * Невалидная структура объекта (не объект, missing fields)
     */
    INVALID_STRUCTURE = "INVALID_STRUCTURE",
    /**
     * Невалидный AssetId
     */
    INVALID_ASSET = "INVALID_ASSET"
}
//# sourceMappingURL=FeeErrorReason.d.ts.map