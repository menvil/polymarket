/**
 * Типизированные причины ошибок TokenBalance
 *
 * @remarks
 * Используется в InvalidTokenBalanceError.context.reason для type-safe обработки ошибок.
 *
 * @example
 * ```typescript
 * const result = TokenBalanceService.create(token, available, reserved, accountId, venueId);
 * if (!result.ok) {
 *   if (result.error.context?.reason === TokenBalanceErrorReason.INVALID_TOKEN) {
 *     console.error('Token is invalid');
 *   }
 * }
 * ```
 */
export var TokenBalanceErrorReason;
(function (TokenBalanceErrorReason) {
    /**
     * OutcomeToken некорректен
     */
    TokenBalanceErrorReason["INVALID_TOKEN"] = "INVALID_TOKEN";
    /**
     * Quantity некорректно (negative, NaN, Infinity)
     */
    TokenBalanceErrorReason["INVALID_AMOUNT"] = "INVALID_AMOUNT";
    /**
     * Общая ошибка валидации при создании
     */
    TokenBalanceErrorReason["INVALID_INPUT"] = "INVALID_INPUT";
    /**
     * Некорректный формат JSON при десериализации
     */
    TokenBalanceErrorReason["INVALID_FORMAT"] = "INVALID_FORMAT";
    /**
     * Математическая операция невозможна (например, вычитание больше чем есть)
     */
    TokenBalanceErrorReason["INVALID_OPERATION"] = "INVALID_OPERATION";
    /**
     * Available amount отрицательный (< 0)
     */
    TokenBalanceErrorReason["NEGATIVE_AVAILABLE"] = "NEGATIVE_AVAILABLE";
    /**
     * Reserved amount отрицательный (< 0)
     */
    TokenBalanceErrorReason["NEGATIVE_RESERVED"] = "NEGATIVE_RESERVED";
    /**
     * Недостаточно available токенов для резервирования
     */
    TokenBalanceErrorReason["INSUFFICIENT_AVAILABLE"] = "INSUFFICIENT_AVAILABLE";
    /**
     * Недостаточно reserved токенов для разморозки/списания
     */
    TokenBalanceErrorReason["INSUFFICIENT_RESERVED"] = "INSUFFICIENT_RESERVED";
    /**
     * Токены не совпадают (разные OutcomeToken)
     */
    TokenBalanceErrorReason["TOKEN_MISMATCH"] = "TOKEN_MISMATCH";
    /**
     * AccountId не совпадают
     */
    TokenBalanceErrorReason["ACCOUNT_MISMATCH"] = "ACCOUNT_MISMATCH";
    /**
     * VenueId не совпадают
     */
    TokenBalanceErrorReason["VENUE_MISMATCH"] = "VENUE_MISMATCH";
    /**
     * Amount является NaN
     */
    TokenBalanceErrorReason["NAN"] = "NAN";
    /**
     * Amount не является finite (Infinity или -Infinity)
     */
    TokenBalanceErrorReason["NON_FINITE"] = "NON_FINITE";
})(TokenBalanceErrorReason || (TokenBalanceErrorReason = {}));
//# sourceMappingURL=TokenBalanceErrorReason.js.map