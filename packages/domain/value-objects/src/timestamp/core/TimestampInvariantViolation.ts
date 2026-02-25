import { TimestampErrorReason } from '../errors/TimestampErrorReason.js';

/**
 * TimestampInvariantViolation - нарушение инварианта Timestamp
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Содержит reason из enum TimestampErrorReason для типизированной обработки ошибок.
 *
 * Возможные причины:
 * - TimestampErrorReason.NOT_FINITE: значение NaN или Infinity
 * - TimestampErrorReason.NOT_POSITIVE: значение <= 0
 *
 * @example
 * ```typescript
 * throw new TimestampInvariantViolation('Timestamp must be finite', TimestampErrorReason.NOT_FINITE);
 * ```
 */
export class TimestampInvariantViolation extends Error {
  public readonly reason:
    | TimestampErrorReason.NOT_FINITE
    | TimestampErrorReason.NOT_POSITIVE;

  constructor(
    message: string,
    reason:
      | TimestampErrorReason.NOT_FINITE
      | TimestampErrorReason.NOT_POSITIVE
  ) {
    super(`Timestamp invariant violation: ${message}`);
    Object.setPrototypeOf(this, TimestampInvariantViolation.prototype);
    this.name = 'TimestampInvariantViolation';
    this.reason = reason;
  }
}
