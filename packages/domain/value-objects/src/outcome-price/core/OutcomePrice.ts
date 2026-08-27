import Decimal from 'decimal.js';
import { OutcomePriceErrorReason } from '../errors/OutcomePriceErrorReason.js';
import { OutcomePriceInvariantViolation } from './OutcomePriceInvariantViolation.js';

/**
 * Core OutcomePrice Value Object
 *
 * @remarks
 * Представляет цену на Polymarket-like рынках предсказаний.
 * Диапазон: [0.0001, 0.9999]
 *
 * Содержит ТОЛЬКО инварианты существования:
 * - Not NaN
 * - Finite
 * - Диапазон [MIN, MAX] (отрицательные значения автоматически отфильтровываются проверкой MIN)
 * - Строгое равенство
 *
 * Методы toTick/floor/ceil/round УДАЛЕНЫ из Core.
 * Используй OutcomePriceService для математических операций.
 */
export class OutcomePrice {
  // Внутренние константы для проверок инвариантов (должны быть определены первыми!)
  private static readonly MIN_PRICE = new Decimal('0.0001');
  private static readonly MAX_PRICE = new Decimal('0.9999');

  /**
   * Минимальная цена (базовый тик Polymarket)
   * Все tickSize должны быть кратны этому значению
   */
  public static readonly MIN = new OutcomePrice(OutcomePrice.MIN_PRICE);

  /**
   * Максимальная цена
   */
  public static readonly MAX = new OutcomePrice(OutcomePrice.MAX_PRICE);

  /**
   * Половина диапазона
   */
  public static readonly HALF = new OutcomePrice(new Decimal('0.5'));

  private constructor(private readonly _value: Decimal) {
    // Инвариант 1: Not NaN
    if (_value.isNaN()) {
      throw new OutcomePriceInvariantViolation('OutcomePrice cannot be NaN', OutcomePriceErrorReason.NAN);
    }

    // Инвариант 2: Must be finite
    if (!_value.isFinite()) {
      throw new OutcomePriceInvariantViolation('OutcomePrice must be finite', OutcomePriceErrorReason.NON_FINITE);
    }

    // Инвариант 3: Must be within valid range [MIN, MAX]
    if (_value.lessThan(OutcomePrice.MIN_PRICE)) {
      throw new OutcomePriceInvariantViolation(
        `OutcomePrice ${_value} is below minimum ${OutcomePrice.MIN_PRICE}`,
        OutcomePriceErrorReason.OUT_OF_RANGE_LOW
      );
    }

    if (_value.greaterThan(OutcomePrice.MAX_PRICE)) {
      throw new OutcomePriceInvariantViolation(
        `OutcomePrice ${_value} exceeds maximum ${OutcomePrice.MAX_PRICE}`,
        OutcomePriceErrorReason.OUT_OF_RANGE_HIGH
      );
    }
  }

  /**
   * Создаёт OutcomePrice из Decimal (ТОЛЬКО для Core!)
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * НЕ парсит - принимает готовый Decimal.
   * Все проверки инвариантов выполняются в конструкторе.
   * Для публичного API используйте OutcomePriceService.create().
   *
   * Конвертация number/string → Decimal делается в OutcomePriceService (Facade layer).
   *
   * @param value - Значение цены (Decimal)
   * @returns OutcomePrice объект
   * @throws {OutcomePriceInvariantViolation} При нарушении инвариантов
   *
   * @example
   * ```typescript
   * // ✅ В Core и Facade
   * const price = OutcomePrice.of(new Decimal('0.5'));
   *
   * // ❌ В публичном коде - используй OutcomePriceService.create()
   * const result = OutcomePriceService.create(0.5);
   * if (!result.ok) {
   *   console.error(result.error);
   * }
   * ```
   */
  public static of(value: Decimal): OutcomePrice {
    return new OutcomePrice(value);
  }

  /**
   * Возвращает Decimal значение
   *
   * @returns Decimal значение цены
   *
   * @example
   * ```typescript
   * const price = OutcomePrice.of(new Decimal(0.5));
   * const decimal = price.value();
   * console.log(decimal.toString()); // "0.5"
   * ```
   */
  public value(): Decimal {
    return this._value;
  }

  /**
   * Возвращает number значение
   *
   * @remarks
   * Может потерять точность для очень больших/малых чисел.
   * Для вычислений используйте value().
   *
   * @returns number значение цены
   *
   * @example
   * ```typescript
   * const price = OutcomePrice.of(new Decimal(0.5));
   * const num = price.toNumber();
   * console.log(num); // 0.5
   * ```
   */
  public toNumber(): number {
    return this._value.toNumber();
  }

  /**
   * Проверяет строгое равенство с другой ценой
   *
   * @remarks
   * СТРОГОЕ равенство по Decimal.equals().
   *
   * @param other - Другая цена
   * @returns true если значения строго равны
   *
   * @example
   * ```typescript
   * const price1 = OutcomePrice.of(new Decimal(0.5));
   * const price2 = OutcomePrice.of(new Decimal(0.5));
   * console.log(price1.equals(price2)); // true
   * ```
   */
  public equals(other: OutcomePrice): boolean {
    return this._value.equals(other._value);
  }

  /**
   * Проверяет что эта цена меньше другой
   *
   * @param other - Другая цена
   * @returns true если this < other
   *
   * @example
   * ```typescript
   * const p1 = OutcomePrice.of(new Decimal(0.5));
   * const p2 = OutcomePrice.of(new Decimal(0.6));
   * console.log(p1.isLessThan(p2)); // true
   * ```
   */
  public isLessThan(other: OutcomePrice): boolean {
    return this._value.lessThan(other._value);
  }

  /**
   * Проверяет что эта цена меньше или равна другой
   *
   * @param other - Другая цена
   * @returns true если this <= other
   *
   * @example
   * ```typescript
   * const p1 = OutcomePrice.of(new Decimal(0.5));
   * const p2 = OutcomePrice.of(new Decimal(0.5));
   * console.log(p1.isLessThanOrEqual(p2)); // true
   * ```
   */
  public isLessThanOrEqual(other: OutcomePrice): boolean {
    return this._value.lessThanOrEqualTo(other._value);
  }

  /**
   * Проверяет что эта цена больше другой
   *
   * @param other - Другая цена
   * @returns true если this > other
   *
   * @example
   * ```typescript
   * const p1 = OutcomePrice.of(new Decimal(0.6));
   * const p2 = OutcomePrice.of(new Decimal(0.5));
   * console.log(p1.isGreaterThan(p2)); // true
   * ```
   */
  public isGreaterThan(other: OutcomePrice): boolean {
    return this._value.greaterThan(other._value);
  }

  /**
   * Проверяет что эта цена больше или равна другой
   *
   * @param other - Другая цена
   * @returns true если this >= other
   *
   * @example
   * ```typescript
   * const p1 = OutcomePrice.of(new Decimal(0.5));
   * const p2 = OutcomePrice.of(new Decimal(0.5));
   * console.log(p1.isGreaterThanOrEqual(p2)); // true
   * ```
   */
  public isGreaterThanOrEqual(other: OutcomePrice): boolean {
    return this._value.greaterThanOrEqualTo(other._value);
  }

  /**
   * Проверяет что цена равна нулю
   *
   * @returns false - OutcomePrice не может быть нулем (MIN = 0.0001)
   *
   * @remarks
   * Этот метод всегда возвращает false, т.к. минимальная цена 0.0001.
   * Добавлен для единообразия API с Quantity и Money.
   *
   * @example
   * ```typescript
   * const price = OutcomePrice.of(new Decimal(0.5));
   * console.log(price.isZero()); // false (всегда)
   * ```
   */
  public isZero(): boolean {
    return false;
  }

  /**
   * Проверяет что это минимальная цена
   *
   * @returns true если цена равна минимальной
   *
   * @example
   * ```typescript
   * const price = OutcomePrice.MIN;
   * console.log(price.isMin()); // true
   * ```
   */
  public isMin(): boolean {
    return this._value.equals(OutcomePrice.MIN_PRICE);
  }

  /**
   * Проверяет что это максимальная цена
   *
   * @returns true если цена равна максимальной
   *
   * @example
   * ```typescript
   * const price = OutcomePrice.MAX;
   * console.log(price.isMax()); // true
   * ```
   */
  public isMax(): boolean {
    return this._value.equals(OutcomePrice.MAX_PRICE);
  }
}
