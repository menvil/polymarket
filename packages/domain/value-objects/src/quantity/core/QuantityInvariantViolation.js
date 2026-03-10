/**
 * QuantityInvariantViolation - нарушение инварианта Quantity
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Содержит reason из enum QuantityErrorReason для типизированной обработки ошибок.
 *
 * Возможные причины:
 * - QuantityErrorReason.NAN: значение NaN
 * - QuantityErrorReason.NON_FINITE: значение не finite (Infinity)
 * - QuantityErrorReason.NEGATIVE: входное значение < 0
 *
 * @example
 * ```typescript
 * throw new QuantityInvariantViolation('Quantity cannot be NaN', QuantityErrorReason.NAN);
 * ```
 */
export class QuantityInvariantViolation extends Error {
    reason;
    constructor(message, reason) {
        super(`Quantity invariant violation: ${message}`);
        Object.setPrototypeOf(this, QuantityInvariantViolation.prototype);
        this.name = 'QuantityInvariantViolation';
        this.reason = reason;
    }
}
//# sourceMappingURL=QuantityInvariantViolation.js.map