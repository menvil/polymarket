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
 * Представляет количество акций/токенов на рынках предсказаний.
 *
 * Содержит ТОЛЬКО инварианты существования:
 * - Non-negative (>= 0)
 * - Finite value (не Infinity, не NaN)
 *
 * НЕ содержит:
 * - Математику (используй @polymarket/math + QuantityService)
 * - Бизнес-правила minSize (используй Rules/Policy)
 * - Округление (используй QuantityService)
 * - Сериализацию (используй Adapters)
 *
 * Внутреннее представление: хранит Decimal (opaque).
 * Наружу отдаёт Decimal через value() и number через toNumber() (lossy).
 *
 * @example
 * ```typescript
 * // Создание
 * const qty1 = Quantity.of(10);         // from number
 * const qty2 = Quantity.of("15.5");     // from string
 *
 * // Создание из готового Decimal (без парсинга)
 * const decimal = new Decimal(20);
 * const qty3 = Quantity.fromDecimal(decimal);
 *
 * // Константы
 * const zero = Quantity.ZERO;
 * const one = Quantity.ONE;
 *
 * // Доступ к значению
 * const decimal = qty1.value();    // Decimal
 * const num = qty1.toNumber();     // number (lossy)
 *
 * // Сравнение (без epsilon)
 * qty1.equals(qty2);     // boolean
 * qty1.isZero();         // boolean
 * qty1.isPositive();     // boolean
 *
 * // Для математики используй QuantityService:
 * const result = QuantityService.add(qty1, qty2);
 * ```
 */
export class Quantity {
  /**
   * Константы для часто используемых значений
   */
  public static readonly ZERO = Quantity.of(0);
  public static readonly ONE = Quantity.of(1);

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
   * Создаёт Quantity из готового Decimal (без повторного парсинга)
   *
   * @remarks
   * Используй когда у тебя уже есть Decimal объект (результат math операций, конфиги).
   * Избегает повторного парсинга и гарантирует единый режим Decimal.
   *
   * ВАЖНО: Не клонирует Decimal, принимает как есть.
   *
   * @param decimal - Готовый Decimal объект
   * @returns Новый Quantity
   * @throws {QuantityInvariantViolation} Если значение не соответствует инвариантам
   *
   * @example
   * ```typescript
   * const decimal = new Decimal(10);
   * const qty = Quantity.fromDecimal(decimal); // НЕ of(decimal)!
   *
   * // После math операций
   * const sum = addDecimal(qty1.value(), qty2.value());
   * const result = Quantity.fromDecimal(sum);
   * ```
   */
  public static fromDecimal(decimal: Decimal): Quantity {
    return new Quantity(decimal);
  }

  /**
   * Возвращает Decimal значение
   *
   * @returns Внутренний Decimal объект
   *
   * @example
   * ```typescript
   * const qty = Quantity.of(10);
   * const decimal = qty.value(); // Decimal
   * ```
   */
  public value(): Decimal {
    return this.v;
  }

  /**
   * Возвращает number значение (lossy conversion)
   *
   * @remarks
   * ⚠️ ВНИМАНИЕ: Преобразование в number может привести к потере точности.
   * Используйте только для отображения или когда точность не критична.
   * Для вычислений используйте value() для получения Decimal.
   *
   * @returns Number значение (может потерять точность для больших чисел)
   *
   * @example
   * ```typescript
   * const qty = Quantity.of("12345678901234567890.123456789");
   * const num = qty.toNumber(); // Может потерять точность!
   * const decimal = qty.value(); // Сохраняет точность
   * ```
   */
  public toNumber(): number {
    return this.v.toNumber();
  }

  /**
   * Проверяет равенство с другим количеством
   *
   * @remarks
   * Точное сравнение без epsilon.
   * Epsilon — это политика сравнения, не свойство Quantity.
   *
   * @param other - Другой Quantity для сравнения
   * @returns true если значения равны, иначе false
   *
   * @example
   * ```typescript
   * const qty1 = Quantity.of(10);
   * const qty2 = Quantity.of(10);
   * const qty3 = Quantity.of(10.0000001);
   *
   * qty1.equals(qty2); // true
   * qty1.equals(qty3); // false (точное сравнение)
   * ```
   */
  public equals(other: Quantity): boolean {
    return this.v.eq(other.v);
  }

  /**
   * Проверяет что количество равно нулю
   *
   * @remarks
   * Точное сравнение без epsilon.
   *
   * @returns true если значение равно 0, иначе false
   *
   * @example
   * ```typescript
   * Quantity.ZERO.isZero();     // true
   * Quantity.of(0).isZero();    // true
   * Quantity.of(0.0001).isZero(); // false (точное сравнение)
   * ```
   */
  public isZero(): boolean {
    return this.v.isZero();
  }

  /**
   * Проверяет что количество положительное (> 0)
   *
   * @returns true если значение > 0, иначе false
   *
   * @example
   * ```typescript
   * Quantity.of(10).isPositive();  // true
   * Quantity.of(0).isPositive();   // false
   * Quantity.ZERO.isPositive();    // false
   * ```
   */
  public isPositive(): boolean {
    return this.v.greaterThan(0);
  }
}
