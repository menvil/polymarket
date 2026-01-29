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

/**
 * Core Quantity Value Object
 *
 * @remarks
 * Содержит ТОЛЬКО инварианты существования:
 * - Non-negative (>= 0)
 * - Finite value (не Infinity, не NaN)
 *
 * НЕ содержит:
 * - Математику (используй @polymarket/math)
 * - Бизнес-правила minSize (используй Rules)
 * - Округление (используй Math)
 * - Сериализацию (используй Adapters)
 */
export class Quantity {
  private constructor(private readonly v: Decimal) {
    // Инвариант 1: Must be finite (покрывает Infinity и NaN)
    if (!v.isFinite()) {
      throw new QuantityInvariantViolation('Quantity value must be finite', 'NON_FINITE');
    }

    // Инвариант 2: Cannot be negative
    if (v.isNegative()) {
      throw new QuantityInvariantViolation('Quantity value cannot be negative', 'NEGATIVE');
    }
  }

  /**
   * Создаёт Quantity из number/string/Decimal
   *
   * @remarks
   * Парсит значение в Decimal через `new Decimal(value)`.
   * Без проверки minSize - это бизнес-правило.
   * Для проверки minSize используй QuantityService.createForOrder()
   *
   * @param value - Значение для парсинга (number, string, или Decimal)
   * @returns Новый Quantity
   * @throws {QuantityInvariantViolation} Если значение не соответствует инвариантам
   *
   * @example
   * ```typescript
   * const qty1 = Quantity.of(10);         // from number
   * const qty2 = Quantity.of("15.5");     // from string
   * const qty3 = Quantity.of(new Decimal(20)); // from Decimal (парсит повторно)
   * ```
   */
  public static of(value: Decimal.Value): Quantity {
    return new Quantity(new Decimal(value));
  }

  /**
   * Возвращает внутреннее значение Decimal
   *
   * @returns Decimal значение
   */
  public value(): Decimal {
    return this.v;
  }
}
