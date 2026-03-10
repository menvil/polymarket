/**
 * Типизированные причины ошибок AssetQuantity
 *
 * @remarks
 * Используется в InvalidAssetQuantityError.context.reason для type-safe обработки ошибок.
 *
 * @example
 * ```typescript
 * const result = AssetQuantityService.create(assetId, qty);
 * if (!result.ok) {
 *   if (result.error.context?.reason === AssetQuantityErrorReason.INVALID_ASSET) {
 *     console.error('Asset is invalid');
 *   }
 * }
 * ```
 */
export var AssetQuantityErrorReason;
(function (AssetQuantityErrorReason) {
    /**
     * AssetId некорректен
     */
    AssetQuantityErrorReason["INVALID_ASSET"] = "INVALID_ASSET";
    /**
     * Quantity некорректно (negative, NaN, Infinity)
     */
    AssetQuantityErrorReason["INVALID_AMOUNT"] = "INVALID_AMOUNT";
    /**
     * Общая ошибка валидации при создании
     */
    AssetQuantityErrorReason["INVALID_INPUT"] = "INVALID_INPUT";
    /**
     * Некорректный формат JSON при десериализации
     */
    AssetQuantityErrorReason["INVALID_FORMAT"] = "INVALID_FORMAT";
    /**
     * Математическая операция невозможна
     */
    AssetQuantityErrorReason["INVALID_OPERATION"] = "INVALID_OPERATION";
    /**
     * Несовместимые типы активов (например, сложение USDC + outcome token)
     */
    AssetQuantityErrorReason["INCOMPATIBLE_ASSETS"] = "INCOMPATIBLE_ASSETS";
})(AssetQuantityErrorReason || (AssetQuantityErrorReason = {}));
//# sourceMappingURL=AssetQuantityErrorReason.js.map