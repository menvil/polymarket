import { SpreadErrorReason } from './SpreadErrorReason.js';

/**
 * Исключение при нарушении инвариантов Spread
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Использует SpreadErrorReason enum для типизации причин.
 *
 * Возможные причины (invariant violations):
 * - BID_GREATER_THAN_ASK: bid > ask (нарушение основного инварианта)
 * - INVALID_BID: bid не является валидным Price
 * - INVALID_ASK: ask не является валидным Price
 */
export class SpreadInvariantViolation extends Error {
  public readonly reason: SpreadErrorReason;

  constructor(message: string, reason: SpreadErrorReason) {
    super(`Spread invariant violation: ${message}`);
    this.name = 'SpreadInvariantViolation';
    this.reason = reason;
  }
}
