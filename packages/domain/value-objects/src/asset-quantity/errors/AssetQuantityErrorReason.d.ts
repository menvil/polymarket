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
export declare enum AssetQuantityErrorReason {
    /**
     * AssetId некорректен
     */
    INVALID_ASSET = "INVALID_ASSET",
    /**
     * Quantity некорректно (negative, NaN, Infinity)
     */
    INVALID_AMOUNT = "INVALID_AMOUNT",
    /**
     * Общая ошибка валидации при создании
     */
    INVALID_INPUT = "INVALID_INPUT",
    /**
     * Некорректный формат JSON при десериализации
     */
    INVALID_FORMAT = "INVALID_FORMAT",
    /**
     * Математическая операция невозможна
     */
    INVALID_OPERATION = "INVALID_OPERATION",
    /**
     * Несовместимые типы активов (например, сложение USDC + outcome token)
     */
    INCOMPATIBLE_ASSETS = "INCOMPATIBLE_ASSETS"
}
//# sourceMappingURL=AssetQuantityErrorReason.d.ts.map