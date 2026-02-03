import Decimal from 'decimal.js';
import { QuantityErrorReason } from '../errors/QuantityErrorReason';

/**
 * QuantityInvariantViolation - нарушение инварианта Quantity
 *
 * @remarks
 * Содержит reason из enum QuantityErrorReason для типизированной обработки ошибок.
 *
 * Возможные причины:
 * - QuantityErrorReason.NAN: значение NaN
 * - QuantityErrorReason.NON_FINITE: значение не finite (Infinity)
 * - QuantityErrorReason.NEGATIVE: входное значение < 0
 *
 * @example
 * ```typescript
 * throw new QuantityInvariantViolation('Quantity cannot be NaN', QuantityErrorReason.NAN);
 * ```
 */
export class QuantityInvariantViolation extends Error {
  public readonly reason: QuantityErrorReason.NAN | QuantityErrorReason.NON_FINITE | QuantityErrorReason.NEGATIVE;

  constructor(message: string, reason: QuantityErrorReason.NAN | QuantityErrorReason.NON_FINITE | QuantityErrorReason.NEGATIVE) {
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
 * qty1.isLessThan(qty2); // boolean
 * qty1.isLessThanOrEqual(qty2); // boolean
 * qty1.isGreaterThan(qty2); // boolean
 * qty1.isGreaterThanOrEqual(qty2); // boolean
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

  private constructor(private readonly _value: Decimal) {
    // Инвариант 1: Not NaN (explicit check for consistency)
    if (_value.isNaN()) {
      throw new QuantityInvariantViolation('Quantity cannot be NaN', QuantityErrorReason.NAN);
    }

    // Инвариант 2: Must be finite
    if (!_value.isFinite()) {
      throw new QuantityInvariantViolation('Quantity must be finite', QuantityErrorReason.NON_FINITE);
    }

    // Инвариант 3: Cannot be negative
    if (_value.isNegative()) {
      throw new QuantityInvariantViolation('Quantity cannot be negative', QuantityErrorReason.NEGATIVE);
    }
  }

  /**
   * Создаёт Quantity из number/string/Decimal
   *
   * @remarks
   * Парсит значение в Decimal через `new Decimal(value)`.
   * Оптимизация: если value уже Decimal, используется напрямую без повторной конверсии.
   * Без проверки minSize - это бизнес-правило.
   * Для проверки minSize используй QuantityService.createForOrder()
   *
   * @param value - Значение для парсинга (number, string, или Decimal)
   * @returns Новый Quantity
   * @throws {QuantityInvariantViolation} Если значение не соответствует инвариантам
   *
   * @example
   * ```typescript
   * const qty1 = Quantity.of(10);                // from number
   * const qty2 = Quantity.of("15.5");            // from string
   * const qty3 = Quantity.of(new Decimal(20));   // from Decimal (без повторного парсинга)
   * ```
   */
  public static of(value: number | string | Decimal): Quantity {
    return value instanceof Decimal
      ? Quantity.fromDecimal(value)
      : new Quantity(new Decimal(value));
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
    return this._value;
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
    return this._value.toNumber();
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
    return this._value.eq(other._value);
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
    return this._value.isZero();
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
    return this._value.greaterThan(0);
  }

  /**
   * Проверяет что это количество меньше другого
   *
   * @remarks
   * Точное сравнение без epsilon.
   *
   * @param other - Другой Quantity для сравнения
   * @returns true если this < other, иначе false
   *
   * @example
   * ```typescript
   * const qty1 = Quantity.of(5);
   * const qty2 = Quantity.of(10);
   *
   * qty1.isLessThan(qty2);  // true
   * qty2.isLessThan(qty1);  // false
   * qty1.isLessThan(qty1);  // false (равны)
   * ```
   */
  public isLessThan(other: Quantity): boolean {
    return this._value.lessThan(other._value);
  }

  /**
   * Проверяет что это количество меньше или равно другому
   *
   * @remarks
   * Точное сравнение без epsilon.
   *
   * @param other - Другой Quantity для сравнения
   * @returns true если this <= other, иначе false
   *
   * @example
   * ```typescript
   * const qty1 = Quantity.of(5);
   * const qty2 = Quantity.of(10);
   *
   * qty1.isLessThanOrEqual(qty2);  // true
   * qty2.isLessThanOrEqual(qty1);  // false
   * qty1.isLessThanOrEqual(qty1);  // true (равны)
   * ```
   */
  public isLessThanOrEqual(other: Quantity): boolean {
    return this._value.lessThanOrEqualTo(other._value);
  }

  /**
   * Проверяет что это количество больше другого
   *
   * @remarks
   * Точное сравнение без epsilon.
   *
   * @param other - Другой Quantity для сравнения
   * @returns true если this > other, иначе false
   *
   * @example
   * ```typescript
   * const qty1 = Quantity.of(10);
   * const qty2 = Quantity.of(5);
   *
   * qty1.isGreaterThan(qty2);  // true
   * qty2.isGreaterThan(qty1);  // false
   * qty1.isGreaterThan(qty1);  // false (равны)
   * ```
   */
  public isGreaterThan(other: Quantity): boolean {
    return this._value.greaterThan(other._value);
  }

  /**
   * Проверяет что это количество больше или равно другому
   *
   * @remarks
   * Точное сравнение без epsilon.
   *
   * @param other - Другой Quantity для сравнения
   * @returns true если this >= other, иначе false
   *
   * @example
   * ```typescript
   * const qty1 = Quantity.of(10);
   * const qty2 = Quantity.of(5);
   *
   * qty1.isGreaterThanOrEqual(qty2);  // true
   * qty2.isGreaterThanOrEqual(qty1);  // false
   * qty1.isGreaterThanOrEqual(qty1);  // true (равны)
   * ```
   */
  public isGreaterThanOrEqual(other: Quantity): boolean {
    return this._value.greaterThanOrEqualTo(other._value);
  }
}
