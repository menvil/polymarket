/**
 * TimestampInvariantViolation - нарушение инварианта Timestamp
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Содержит reason из enum TimestampErrorReason для типизированной обработки ошибок.
 *
 * Возможные причины (из TimestampErrorReason):
 * - NOT_FINITE: значение NaN или Infinity
 * - NEGATIVE: значение < 0
 * - NOT_INTEGER: дробное значение (Core level only; Facade делает truncate)
 * - OUT_OF_RANGE: значение > 9999999999999 (~год 2286)
 *
 * @example
 * ```typescript
 * throw new TimestampInvariantViolation('Timestamp must be finite', TimestampErrorReason.NOT_FINITE);
 * ```
 */
export class TimestampInvariantViolation extends Error {
    reason;
    constructor(message, reason) {
        super(`Timestamp invariant violation: ${message}`);
        Object.setPrototypeOf(this, TimestampInvariantViolation.prototype);
        this.name = 'TimestampInvariantViolation';
        this.reason = reason;
    }
}
//# sourceMappingURL=TimestampInvariantViolation.js.map