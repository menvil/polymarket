import { OutcomePriceErrorReason } from '../errors/OutcomePriceErrorReason.js';

/**
 * Исключение при нарушении инвариантов OutcomePrice
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Содержит reason из enum OutcomePriceErrorReason для типизированной обработки ошибок.
 *
 * Возможные причины:
 * - OutcomePriceErrorReason.NAN: значение является NaN
 * - OutcomePriceErrorReason.NON_FINITE: значение не finite (Infinity, -Infinity)
 * - OutcomePriceErrorReason.OUT_OF_RANGE_LOW: значение < MIN_PRICE
 * - OutcomePriceErrorReason.OUT_OF_RANGE_HIGH: значение > MAX_PRICE
 *
 * @example
 * ```typescript
 * throw new OutcomePriceInvariantViolation('OutcomePrice cannot be NaN', OutcomePriceErrorReason.NAN);
 * ```
 */
export class OutcomePriceInvariantViolation extends Error {
  public readonly reason:
    | OutcomePriceErrorReason.NAN
    | OutcomePriceErrorReason.NON_FINITE
    | OutcomePriceErrorReason.OUT_OF_RANGE_LOW
    | OutcomePriceErrorReason.OUT_OF_RANGE_HIGH;

  constructor(
    message: string,
    reason:
      | OutcomePriceErrorReason.NAN
      | OutcomePriceErrorReason.NON_FINITE
      | OutcomePriceErrorReason.OUT_OF_RANGE_LOW
      | OutcomePriceErrorReason.OUT_OF_RANGE_HIGH
  ) {
    super(`OutcomePrice invariant violation: ${message}`);
    Object.setPrototypeOf(this, OutcomePriceInvariantViolation.prototype);
    this.name = 'OutcomePriceInvariantViolation';
    this.reason = reason;
  }
}
