import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';

/**
 * SignedQuantityInvariantViolation - нарушение инварианта SignedQuantity
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Содержит reason из enum SignedQuantityErrorReason для типизированной обработки ошибок.
 *
 * Возможные причины:
 * - SignedQuantityErrorReason.NAN: значение NaN
 * - SignedQuantityErrorReason.NON_FINITE: значение Infinity или -Infinity
 *
 * @example
 * ```typescript
 * throw new SignedQuantityInvariantViolation(
 *   'SignedQuantity cannot be NaN',
 *   SignedQuantityErrorReason.NAN
 * );
 * ```
 */
export class SignedQuantityInvariantViolation extends Error {
  public readonly reason:
    | SignedQuantityErrorReason.NAN
    | SignedQuantityErrorReason.NON_FINITE;

  constructor(
    message: string,
    reason:
      | SignedQuantityErrorReason.NAN
      | SignedQuantityErrorReason.NON_FINITE
  ) {
    super(`SignedQuantity invariant violation: ${message}`);
    Object.setPrototypeOf(this, SignedQuantityInvariantViolation.prototype);
    this.name = 'SignedQuantityInvariantViolation';
    this.reason = reason;
  }
}
