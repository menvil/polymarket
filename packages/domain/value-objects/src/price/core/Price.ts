import Decimal from 'decimal.js';
import { PriceErrorReason } from '../errors/PriceErrorReason';

/**
 * Исключение при нарушении инвариантов Price
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 *
 * Содержит reason из enum PriceErrorReason для типизированной обработки ошибок.
 *
 * Возможные причины:
 * - PriceErrorReason.NAN: значение является NaN
 * - PriceErrorReason.NON_FINITE: значение не finite (Infinity, -Infinity)
 * - PriceErrorReason.OUT_OF_RANGE_LOW: значение < MIN_PRICE
 * - PriceErrorReason.OUT_OF_RANGE_HIGH: значение > MAX_PRICE
 */
export class PriceInvariantViolation extends Error {
  public readonly reason:
    | PriceErrorReason.NAN
    | PriceErrorReason.NON_FINITE
    | PriceErrorReason.OUT_OF_RANGE_LOW
    | PriceErrorReason.OUT_OF_RANGE_HIGH;

  constructor(
    message: string,
    reason:
      | PriceErrorReason.NAN
      | PriceErrorReason.NON_FINITE
      | PriceErrorReason.OUT_OF_RANGE_LOW
      | PriceErrorReason.OUT_OF_RANGE_HIGH
  ) {
    super(`Price invariant violation: ${message}`);
    Object.setPrototypeOf(this, PriceInvariantViolation.prototype);
    this.name = 'PriceInvariantViolation';
    this.reason = reason;
  }
}

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

  private constructor(private readonly v: Decimal) {
    // Инвариант 1: Not NaN
    if (v.isNaN()) {
      throw new PriceInvariantViolation('Price cannot be NaN', PriceErrorReason.NAN);
    }

    // Инвариант 2: Must be finite
    if (!v.isFinite()) {
      throw new PriceInvariantViolation('Price must be finite', PriceErrorReason.NON_FINITE);
    }

    // Инвариант 3: Must be within valid range [MIN, MAX]
    if (v.lessThan(Price.MIN_PRICE)) {
      throw new PriceInvariantViolation(
        `Price ${v} is below minimum ${Price.MIN_PRICE}`,
        PriceErrorReason.OUT_OF_RANGE_LOW
      );
    }

    if (v.greaterThan(Price.MAX_PRICE)) {
      throw new PriceInvariantViolation(
        `Price ${v} exceeds maximum ${Price.MAX_PRICE}`,
        PriceErrorReason.OUT_OF_RANGE_HIGH
      );
    }
  }

  /**
   * Создаёт Price из Decimal значения (ТОЛЬКО для Core!)
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Бросает PriceInvariantViolation при нарушении инвариантов.
   * Все проверки инвариантов выполняются в конструкторе.
   * Для публичного API используйте PriceService.create().
   *
   * @param decimal - Decimal значение цены
   * @returns Price объект
   * @throws {PriceInvariantViolation} При нарушении инвариантов
   *
   * @example
   * ```typescript
   * // ✅ В Core и Facade
   * const price = Price.fromDecimal(new Decimal(0.5));
   *
   * // ❌ В публичном коде - используй PriceService.create()
   * const result = PriceService.create(0.5);
   * if (!result.ok) {
   *   console.error(result.error);
   * }
   * ```
   */
  public static fromDecimal(decimal: Decimal): Price {
    return new Price(decimal);
  }

  /**
   * Создаёт Price из значения (ТОЛЬКО для Core!)
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Бросает PriceInvariantViolation при нарушении инвариантов.
   * Для публичного API используйте PriceService.create().
   *
   * @param value - Значение цены (number, string или Decimal)
   * @returns Price объект
   * @throws {PriceInvariantViolation} При нарушении инвариантов
   *
   * @example
   * ```typescript
   * // ✅ В Core и Facade
   * const price = Price.of(0.5);
   *
   * // ❌ В публичном коде - используй PriceService.create()
   * const result = PriceService.create(0.5);
   * if (!result.ok) {
   *   console.error(result.error);
   * }
   * ```
   */
  public static of(value: number | string | Decimal): Price {
    return value instanceof Decimal
      ? Price.fromDecimal(value)
      : new Price(new Decimal(value));
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
    return this.v;
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
    return this.v.toNumber();
  }

  /**
   * Проверяет строгое равенство с другой ценой
   *
   * @remarks
   * СТРОГОЕ равенство по Decimal.equals().
   * Для approximate equality используй PriceService.approximatelyEquals().
   *
   * @param other - Другая цена
   * @returns true если значения строго равны
   *
   * @example
   * ```typescript
   * const price1 = Price.of(0.5);
   * const price2 = Price.of(0.5);
   * console.log(price1.equals(price2)); // true
   * ```
   */
  public equals(other: Price): boolean {
    return this.v.equals(other.v);
  }

  /**
   * Проверяет что это минимальная цена
   *
   * @returns true если цена равна минимальной
   *
   * @example
   * ```typescript
   * const price = Price.min();
   * console.log(price.isMin()); // true
   * ```
   */
  public isMin(): boolean {
    return this.v.equals(Price.MIN_PRICE);
  }

  /**
   * Проверяет что это максимальная цена
   *
   * @returns true если цена равна максимальной
   *
   * @example
   * ```typescript
   * const price = Price.max();
   * console.log(price.isMax()); // true
   * ```
   */
  public isMax(): boolean {
    return this.v.equals(Price.MAX_PRICE);
  }
}
