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
export declare enum TokenBalanceErrorReason {
    /**
     * OutcomeToken некорректен
     */
    INVALID_TOKEN = "INVALID_TOKEN",
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
     * Математическая операция невозможна (например, вычитание больше чем есть)
     */
    INVALID_OPERATION = "INVALID_OPERATION",
    /**
     * Available amount отрицательный (< 0)
     */
    NEGATIVE_AVAILABLE = "NEGATIVE_AVAILABLE",
    /**
     * Reserved amount отрицательный (< 0)
     */
    NEGATIVE_RESERVED = "NEGATIVE_RESERVED",
    /**
     * Недостаточно available токенов для резервирования
     */
    INSUFFICIENT_AVAILABLE = "INSUFFICIENT_AVAILABLE",
    /**
     * Недостаточно reserved токенов для разморозки/списания
     */
    INSUFFICIENT_RESERVED = "INSUFFICIENT_RESERVED",
    /**
     * Токены не совпадают (разные OutcomeToken)
     */
    TOKEN_MISMATCH = "TOKEN_MISMATCH",
    /**
     * AccountId не совпадают
     */
    ACCOUNT_MISMATCH = "ACCOUNT_MISMATCH",
    /**
     * VenueId не совпадают
     */
    VENUE_MISMATCH = "VENUE_MISMATCH",
    /**
     * Amount является NaN
     */
    NAN = "NAN",
    /**
     * Amount не является finite (Infinity или -Infinity)
     */
    NON_FINITE = "NON_FINITE"
}
//# sourceMappingURL=TokenBalanceErrorReason.d.ts.map