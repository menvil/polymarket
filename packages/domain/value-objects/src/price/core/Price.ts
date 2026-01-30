import Decimal from 'decimal.js';

/**
 * Исключение при нарушении инвариантов Price
 *
 * @remarks
 * Бросается только внутри Core при нарушении инвариантов существования.
 * Facade обязан ловить и оборачивать в Result<T, E>.
 */
export class PriceInvariantViolation extends Error {
  constructor(message: string) {
    super(`Price invariant violation: ${message}`);
    this.name = 'PriceInvariantViolation';
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
 * - Диапазон [MIN, MAX]
 * - Строгое равенство
 *
 * Методы toTick/floor/ceil/round УДАЛЕНЫ из Core.
 * Используй PriceService для математических операций.
 */
export class Price {
  // MIN_PRICE служит базовым тиком Polymarket (0.0001)
  // Все tickSize должны быть кратны этому значению
  private static readonly MIN_PRICE = new Decimal(0.0001);
  private static readonly MAX_PRICE = new Decimal(0.9999);
  private static readonly HALF_PRICE = new Decimal(0.5);

  private constructor(private readonly v: Decimal) {
    // Инвариант 1: Not NaN
    if (v.isNaN()) {
      throw new PriceInvariantViolation('Price cannot be NaN');
    }

    // Инвариант 2: Must be finite
    if (!v.isFinite()) {
      throw new PriceInvariantViolation('Price must be finite');
    }

    // Инвариант 3: Cannot be negative
    if (v.isNegative()) {
      throw new PriceInvariantViolation('Price value cannot be negative');
    }

    // Инвариант 4: Must be within valid range [MIN, MAX]
    if (v.lessThan(Price.MIN_PRICE)) {
      throw new PriceInvariantViolation(
        `Price ${v} is below minimum ${Price.MIN_PRICE}`
      );
    }

    if (v.greaterThan(Price.MAX_PRICE)) {
      throw new PriceInvariantViolation(
        `Price ${v} exceeds maximum ${Price.MAX_PRICE}`
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
   * Возвращает минимальную цену (0.0001)
   *
   * @returns Price объект с минимальным значением
   *
   * @example
   * ```typescript
   * const minPrice = Price.min();
   * console.log(minPrice.toNumber()); // 0.0001
   * ```
   */
  public static min(): Price {
    return new Price(Price.MIN_PRICE);
  }

  /**
   * Возвращает максимальную цену (0.9999)
   *
   * @returns Price объект с максимальным значением
   *
   * @example
   * ```typescript
   * const maxPrice = Price.max();
   * console.log(maxPrice.toNumber()); // 0.9999
   * ```
   */
  public static max(): Price {
    return new Price(Price.MAX_PRICE);
  }

  /**
   * Возвращает половину диапазона (0.5)
   *
   * @returns Price объект со значением 0.5
   *
   * @example
   * ```typescript
   * const halfPrice = Price.half();
   * console.log(halfPrice.toNumber()); // 0.5
   * ```
   */
  public static half(): Price {
    return new Price(Price.HALF_PRICE);
  }

  /**
   * Возвращает минимальное значение как Decimal (internal use only)
   *
   * @internal ТОЛЬКО для Rules/Facade внутри пакета
   *
   * @remarks
   * Возвращает shared Decimal константу.
   * МУТАЦИИ ЗАПРЕЩЕНЫ - повлияет на всю систему!
   * Для публичного API используйте Price.min().
   *
   * @returns Decimal константа минимального значения
   */
  public static minValue(): Decimal {
    return Price.MIN_PRICE;
  }

  /**
   * Возвращает максимальное значение как Decimal (internal use only)
   *
   * @internal ТОЛЬКО для Rules/Facade внутри пакета
   *
   * @remarks
   * Возвращает shared Decimal константу.
   * МУТАЦИИ ЗАПРЕЩЕНЫ - повлияет на всю систему!
   * Для публичного API используйте Price.max().
   *
   * @returns Decimal константа максимального значения
   */
  public static maxValue(): Decimal {
    return Price.MAX_PRICE;
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

  /**
   * Проверяет что эта цена меньше другой
   *
   * @remarks
   * Точное сравнение без epsilon.
   *
   * @param other - Другая цена для сравнения
   * @returns true если this < other, иначе false
   *
   * @example
   * ```typescript
   * const price1 = Price.of(0.3);
   * const price2 = Price.of(0.5);
   *
   * price1.isLessThan(price2);  // true
   * price2.isLessThan(price1);  // false
   * price1.isLessThan(price1);  // false (равны)
   * ```
   */
  public isLessThan(other: Price): boolean {
    return this.v.lessThan(other.v);
  }

  /**
   * Проверяет что эта цена меньше или равна другой
   *
   * @remarks
   * Точное сравнение без epsilon.
   *
   * @param other - Другая цена для сравнения
   * @returns true если this <= other, иначе false
   *
   * @example
   * ```typescript
   * const price1 = Price.of(0.3);
   * const price2 = Price.of(0.5);
   *
   * price1.isLessThanOrEqual(price2);  // true
   * price2.isLessThanOrEqual(price1);  // false
   * price1.isLessThanOrEqual(price1);  // true (равны)
   * ```
   */
  public isLessThanOrEqual(other: Price): boolean {
    return this.v.lessThanOrEqualTo(other.v);
  }

  /**
   * Проверяет что эта цена больше другой
   *
   * @remarks
   * Точное сравнение без epsilon.
   *
   * @param other - Другая цена для сравнения
   * @returns true если this > other, иначе false
   *
   * @example
   * ```typescript
   * const price1 = Price.of(0.7);
   * const price2 = Price.of(0.3);
   *
   * price1.isGreaterThan(price2);  // true
   * price2.isGreaterThan(price1);  // false
   * price1.isGreaterThan(price1);  // false (равны)
   * ```
   */
  public isGreaterThan(other: Price): boolean {
    return this.v.greaterThan(other.v);
  }

  /**
   * Проверяет что эта цена больше или равна другой
   *
   * @remarks
   * Точное сравнение без epsilon.
   *
   * @param other - Другая цена для сравнения
   * @returns true если this >= other, иначе false
   *
   * @example
   * ```typescript
   * const price1 = Price.of(0.7);
   * const price2 = Price.of(0.3);
   *
   * price1.isGreaterThanOrEqual(price2);  // true
   * price2.isGreaterThanOrEqual(price1);  // false
   * price1.isGreaterThanOrEqual(price1);  // true (равны)
   * ```
   */
  public isGreaterThanOrEqual(other: Price): boolean {
    return this.v.greaterThanOrEqualTo(other.v);
  }
}
