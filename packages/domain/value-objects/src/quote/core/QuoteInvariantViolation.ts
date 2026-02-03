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
  public readonly reason: 'BOTH_SIDES_NULL' | 'BID_GREATER_THAN_ASK';

  constructor(
    message: string,
    reason: 'BOTH_SIDES_NULL' | 'BID_GREATER_THAN_ASK'
  ) {
    super(`Quote invariant violation: ${message}`);
    this.name = 'QuoteInvariantViolation';
    this.reason = reason;
  }
}
