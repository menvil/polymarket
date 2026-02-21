/**
 * Типизированные причины нарушения инвариантов Quote
 *
 * @remarks
 * Используется в QuoteInvariantViolation для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 */
export type QuoteInvariantReason =
  | 'BOTH_SIDES_NULL'
  | 'BID_GREATER_THAN_ASK'
  | 'INVALID_TIMESTAMP'
  | 'INCONSISTENT_BID_SIZE'
  | 'INCONSISTENT_ASK_SIZE';

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
  public readonly reason: QuoteInvariantReason;

  constructor(message: string, reason: QuoteInvariantReason) {
    super(`Quote invariant violation: ${message}`);
    this.name = 'QuoteInvariantViolation';
    this.reason = reason;

    // Восстанавливаем правильную цепочку прототипов для instanceof
    Object.setPrototypeOf(this, QuoteInvariantViolation.prototype);
  }
}
