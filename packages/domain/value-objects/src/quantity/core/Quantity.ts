import Decimal from 'decimal.js';

/**
 * QuantityInvariantViolation - нарушение инварианта Quantity
 *
 * @remarks
 * Содержит reason как union type для структурированной обработки ошибок.
 *
 * Возможные причины:
 * - NEGATIVE: значение < 0
 * - NON_FINITE: значение не finite (Infinity, NaN)
 *
 * @example
 * ```typescript
 * throw new QuantityInvariantViolation('Quantity value cannot be negative', 'NEGATIVE');
 * ```
 */
export class QuantityInvariantViolation extends Error {
  public readonly reason: 'NEGATIVE' | 'NON_FINITE';

  constructor(message: string, reason: 'NEGATIVE' | 'NON_FINITE') {
    super(`Quantity invariant violation: ${message}`);
    this.name = 'QuantityInvariantViolation';
    this.reason = reason;
  }
}
