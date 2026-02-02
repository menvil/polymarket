/**
 * Исключение при нарушении инвариантов Percentage
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Содержит reason как union type для структурированной обработки ошибок.
 *
 * Возможные причины:
 * - NAN: значение является NaN
 * - NON_FINITE: значение не finite (Infinity, -Infinity)
 * - OUT_OF_RANGE_LOW: значение < MIN_PERCENTAGE
 * - OUT_OF_RANGE_HIGH: значение > MAX_PERCENTAGE
 */
export class PercentageInvariantViolation extends Error {
  public readonly reason: 'NAN' | 'NON_FINITE' | 'OUT_OF_RANGE_LOW' | 'OUT_OF_RANGE_HIGH';

  constructor(
    message: string,
    reason: 'NAN' | 'NON_FINITE' | 'OUT_OF_RANGE_LOW' | 'OUT_OF_RANGE_HIGH'
  ) {
    super(`Percentage invariant violation: ${message}`);
    this.name = 'PercentageInvariantViolation';
    this.reason = reason;
  }
}
