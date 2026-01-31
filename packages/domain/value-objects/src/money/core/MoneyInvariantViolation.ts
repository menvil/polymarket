/**
 * Исключение, выбрасываемое при нарушении инвариантов Money.
 *
 * @remarks
 * ## Инварианты Money (проверяются УЖЕ существующего Decimal + currency):
 * - Валюта должна быть поддерживаемой (USDC)
 * - Сумма должна быть конечным числом (finite)
 * - Сумма должна быть валидным числом (не NaN)
 * - Сумма не должна превышать MAX_AMOUNT (1e15)
 *
 * ## НЕ инвариант:
 * - Формат входных данных (это parse error → {@link MoneyParseError})
 *
 * Это исключение используется только внутри core слоя Money.
 * Facade слой (MoneyService) ловит это исключение и преобразует в Result.
 *
 * @example
 * ```typescript
 * throw new MoneyInvariantViolation('Amount exceeds maximum', 'EXCEEDS_MAX_AMOUNT');
 * ```
 */
export class MoneyInvariantViolation extends Error {
  public readonly reason:
    | 'UNSUPPORTED_CURRENCY'
    | 'NAN'
    | 'NON_FINITE'
    | 'EXCEEDS_MAX_AMOUNT';

  constructor(message: string, reason: MoneyInvariantViolation['reason']) {
    super(`Money invariant violation: ${message}`);
    this.name = 'MoneyInvariantViolation';
    this.reason = reason;
  }
}
