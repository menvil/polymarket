/**
 * Типизированные причины ошибок Fee
 *
 * @remarks
 * Используется в ValidationError.context.reason для идентификации типа ошибки.
 */
export var FeeErrorReason;
(function (FeeErrorReason) {
    /**
     * Отрицательная комиссия (не допускается)
     */
    FeeErrorReason["NEGATIVE_FEE"] = "NEGATIVE_FEE";
    /**
     * Невалидный AssetQuantity или amount
     */
    FeeErrorReason["INVALID_QUANTITY"] = "INVALID_QUANTITY";
    /**
     * Невалидная структура объекта (не объект, missing fields)
     */
    FeeErrorReason["INVALID_STRUCTURE"] = "INVALID_STRUCTURE";
    /**
     * Невалидный AssetId
     */
    FeeErrorReason["INVALID_ASSET"] = "INVALID_ASSET";
})(FeeErrorReason || (FeeErrorReason = {}));
//# sourceMappingURL=FeeErrorReason.js.map