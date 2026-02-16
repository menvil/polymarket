import Decimal from 'decimal.js';
import { PriceErrorReason } from '../errors/PriceErrorReason.js';
import { PriceInvariantViolation } from './PriceInvariantViolation.js';

/**
 * Core Price Value Object
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
 * Используй PriceService для математических операций.
 */
export class Price {
  // Внутренние константы для проверок инвариантов (должны быть определены первыми!)
  private static readonly MIN_PRICE = new Decimal('0.0001');
  private static readonly MAX_PRICE = new Decimal('0.9999');

  /**
   * Минимальная цена (базовый тик Polymarket)
   * Все tickSize должны быть кратны этому значению
   */
  public static readonly MIN = new Price(Price.MIN_PRICE);

  /**
   * Максимальная цена
   */
  public static readonly MAX = new Price(Price.MAX_PRICE);

  /**
   * Половина диапазона
   */
  public static readonly HALF = new Price(new Decimal('0.5'));

  private constructor(private readonly _value: Decimal) {
    // Инвариант 1: Not NaN
    if (_value.isNaN()) {
      throw new PriceInvariantViolation('Price cannot be NaN', PriceErrorReason.NAN);
    }

    // Инвариант 2: Must be finite
    if (!_value.isFinite()) {
      throw new PriceInvariantViolation('Price must be finite', PriceErrorReason.NON_FINITE);
    }

    // Инвариант 3: Must be within valid range [MIN, MAX]
    if (_value.lessThan(Price.MIN_PRICE)) {
      throw new PriceInvariantViolation(
        `Price ${_value} is below minimum ${Price.MIN_PRICE}`,
        PriceErrorReason.OUT_OF_RANGE_LOW
      );
    }

    if (_value.greaterThan(Price.MAX_PRICE)) {
      throw new PriceInvariantViolation(
        `Price ${_value} exceeds maximum ${Price.MAX_PRICE}`,
        PriceErrorReason.OUT_OF_RANGE_HIGH
      );
    }
  }

  /**
   * Создаёт Price из Decimal (ТОЛЬКО для Core!)
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * НЕ парсит - принимает готовый Decimal.
   * Все проверки инвариантов выполняются в конструкторе.
   * Для публичного API используйте PriceService.create().
   *
   * Конвертация number/string → Decimal делается в PriceService (Facade layer).
   *
   * @param value - Значение цены (Decimal)
   * @returns Price объект
   * @throws {PriceInvariantViolation} При нарушении инвариантов
   *
   * @example
   * ```typescript
   * // ✅ В Core и Facade
   * const price = Price.of(new Decimal('0.5'));
   *
   * // ❌ В публичном коде - используй PriceService.create()
   * const result = PriceService.create(0.5);
   * if (!result.ok) {
   *   console.error(result.error);
   * }
   * ```
   */
  public static of(value: Decimal): Price {
    return new Price(value);
  }

  /**
   * Возвращает Decimal значение
   *
   * @returns Decimal значение цены
   *
   * @example
   * ```typescript
   * const price = Price.of(0.5);
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
   * const price = Price.of(0.5);
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
   * const price1 = Price.of(new Decimal(0.5));
   * const price2 = Price.of(new Decimal(0.5));
   * console.log(price1.equals(price2)); // true
   * ```
   */
  public equals(other: Price): boolean {
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
   * const p1 = Price.of(0.5);
   * const p2 = Price.of(0.6);
   * console.log(p1.isLessThan(p2)); // true
   * ```
   */
  public isLessThan(other: Price): boolean {
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
   * const p1 = Price.of(0.5);
   * const p2 = Price.of(0.5);
   * console.log(p1.isLessThanOrEqual(p2)); // true
   * ```
   */
  public isLessThanOrEqual(other: Price): boolean {
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
   * const p1 = Price.of(0.6);
   * const p2 = Price.of(0.5);
   * console.log(p1.isGreaterThan(p2)); // true
   * ```
   */
  public isGreaterThan(other: Price): boolean {
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
   * const p1 = Price.of(0.5);
   * const p2 = Price.of(0.5);
   * console.log(p1.isGreaterThanOrEqual(p2)); // true
   * ```
   */
  public isGreaterThanOrEqual(other: Price): boolean {
    return this._value.greaterThanOrEqualTo(other._value);
  }

  /**
   * Проверяет что цена равна нулю
   *
   * @returns false - Price не может быть нулем (MIN = 0.0001)
   *
   * @remarks
   * Этот метод всегда возвращает false, т.к. минимальная цена 0.0001.
   * Добавлен для единообразия API с Quantity и Money.
   *
   * @example
   * ```typescript
   * const price = Price.of(0.5);
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
   * const price = Price.MIN;
   * console.log(price.isMin()); // true
   * ```
   */
  public isMin(): boolean {
    return this._value.equals(Price.MIN_PRICE);
  }

  /**
   * Проверяет что это максимальная цена
   *
   * @returns true если цена равна максимальной
   *
   * @example
   * ```typescript
   * const price = Price.MAX;
   * console.log(price.isMax()); // true
   * ```
   */
  public isMax(): boolean {
    return this._value.equals(Price.MAX_PRICE);
  }
}
