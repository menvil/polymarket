/**
 * Исключение при нарушении инвариантов TokenBalance
 *
 * @remarks
 * Бросается ТОЛЬКО из Core слоя при создании TokenBalance через конструктор/фабрику.
 * Означает что внутренний стейт будет некорректным и объект не может существовать.
 *
 * Core НЕ использует Result<T, E> - бросает исключения напрямую.
 * Facade перехватывает исключения через wrapOp и конвертирует в Result.Err с InvalidTokenBalanceError.
 *
 * @example
 * ```typescript
 * // В Core (internal)
 * if (!token) {
 *   throw new TokenBalanceInvariantViolation('token is required', TokenBalanceErrorReason.INVALID_TOKEN);
 * }
 *
 * // В Facade (wrapOp automatically catches)
 * return wrapOp(
 *   TokenBalanceService.SERVICE_NAME,
 *   'create',
 *   { token, available, reserved, accountId, venueId },
 *   () => {
 *     const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
 *     return Ok(balance);
 *   },
 *   InvalidTokenBalanceError
 * );
 * // TokenBalanceInvariantViolation автоматически ловится и конвертируется в InvalidTokenBalanceError
 * ```
 */
export class TokenBalanceInvariantViolation extends Error {
    reason;
    constructor(message, reason) {
        super(message);
        this.reason = reason;
        Object.setPrototypeOf(this, TokenBalanceInvariantViolation.prototype);
        this.name = 'TokenBalanceInvariantViolation';
    }
}
//# sourceMappingURL=TokenBalanceInvariantViolation.js.map