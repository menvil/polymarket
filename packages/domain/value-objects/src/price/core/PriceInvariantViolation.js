/**
 * Исключение при нарушении инвариантов Price
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Содержит reason из enum PriceErrorReason для типизированной обработки ошибок.
 *
 * Возможные причины:
 * - PriceErrorReason.NAN: значение является NaN
 * - PriceErrorReason.NON_FINITE: значение не finite (Infinity, -Infinity)
 * - PriceErrorReason.OUT_OF_RANGE_LOW: значение < MIN_PRICE
 * - PriceErrorReason.OUT_OF_RANGE_HIGH: значение > MAX_PRICE
 *
 * @example
 * ```typescript
 * throw new PriceInvariantViolation('Price cannot be NaN', PriceErrorReason.NAN);
 * ```
 */
export class PriceInvariantViolation extends Error {
    reason;
    constructor(message, reason) {
        super(`Price invariant violation: ${message}`);
        Object.setPrototypeOf(this, PriceInvariantViolation.prototype);
        this.name = 'PriceInvariantViolation';
        this.reason = reason;
    }
}
//# sourceMappingURL=PriceInvariantViolation.js.map