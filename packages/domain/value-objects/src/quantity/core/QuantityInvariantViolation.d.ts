import { QuantityErrorReason } from '../errors/QuantityErrorReason.js';
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
export declare class QuantityInvariantViolation extends Error {
    readonly reason: QuantityErrorReason.NAN | QuantityErrorReason.NON_FINITE | QuantityErrorReason.NEGATIVE;
    constructor(message: string, reason: QuantityErrorReason.NAN | QuantityErrorReason.NON_FINITE | QuantityErrorReason.NEGATIVE);
}
//# sourceMappingURL=QuantityInvariantViolation.d.ts.map