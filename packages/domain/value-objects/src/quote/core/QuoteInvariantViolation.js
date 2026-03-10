/**
 * Исключение при нарушении инвариантов Quote
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Содержит reason как union type для структурированной обработки ошибок.
 *
 * Возможные причины:
 * - BOTH_SIDES_NULL: bid и ask оба null
 * - BID_GREATER_THAN_ASK: bid > ask
 * - INVALID_TIMESTAMP: timestamp не является валидным Unix ms (не finite, не integer, отрицательный, или превышает максимум)
 * - INCONSISTENT_BID_SIZE: bid=null но bidSize>0 (структурная несогласованность)
 * - INCONSISTENT_ASK_SIZE: ask=null но askSize>0 (структурная несогласованность)
 *
 * @example
 * ```typescript
 * throw new QuoteInvariantViolation(
 *   'At least one side must be defined',
 *   'BOTH_SIDES_NULL'
 * );
 * ```
 */
export class QuoteInvariantViolation extends Error {
    reason;
    constructor(message, reason) {
        super(`Quote invariant violation: ${message}`);
        Object.setPrototypeOf(this, QuoteInvariantViolation.prototype);
        this.name = 'QuoteInvariantViolation';
        this.reason = reason;
    }
}
//# sourceMappingURL=QuoteInvariantViolation.js.map