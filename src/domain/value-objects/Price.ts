/**
 * Price value object
 *
 * @remarks
 * Represents a price in prediction markets [0.0001, 0.9999].
 * Immutable value object with validation and rounding.
 *
 * Диапазон расширен с [0.01, 0.99] до [0.0001, 0.9999] для:
 * - Обработки edge-case цен близких к 0 или 1
 * - Предотвращения InvalidPriceError на граничных значениях
 *
 * @example
 * ```typescript
 * const price = Price.fromNumber(0.5234);
 * console.log(price.value); // 0.5234
 * console.log(price.toTick(0.0001)); // 0.5234 (rounded to tick)
 *
 * // Edge cases теперь поддерживаются:
 * const lowPrice = Price.fromNumber(0.001);
 * const highPrice = Price.fromNumber(0.999);
 * ```
 */
import { InvalidPriceError } from '../../shared/errors/TradingError.js';

export class Price {
  public readonly value: number;

  private static readonly MIN_PRICE = 0.0001;
  private static readonly MAX_PRICE = 0.9999;
  private static readonly DEFAULT_TICK = 0.0001; // 1 basis point

  private constructor(value: number) {
    this.value = value;
  }

  /**
   * Creates Price from number
   *
   * @param value - Price value [0.0001, 0.9999]
   * @returns Price instance
   * @throws {InvalidPriceError} If price is out of range
   *
   * @example
   * ```typescript
   * const price = Price.fromNumber(0.5);
   * const edgePrice = Price.fromNumber(0.001); // Edge case supported
   * ```
   */
  public static fromNumber(value: number): Price {
    if (!Price.isValid(value)) {
      throw new InvalidPriceError(value);
    }
    return new Price(value);
  }

  /**
   * Creates Price from string
   * 
   * @param value - Price as string
   * @returns Price instance
   * @throws {InvalidPriceError} If price is invalid
   */
  public static fromString(value: string): Price {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      throw new InvalidPriceError(numValue);
    }
    return Price.fromNumber(numValue);
  }

  /**
   * Validates price value
   * 
   * @param value - Price to validate
   * @returns True if valid
   */
  public static isValid(value: number): boolean {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= Price.MIN_PRICE &&
      value <= Price.MAX_PRICE
    );
  }

  /**
   * Rounds to tick size
   * 
   * @param tickSize - Tick size (default 0.0001)
   * @returns New Price rounded to tick
   * 
   * @remarks
   * Rounds price to nearest tick size.
   * Example: 0.5234 with tick 0.01 becomes 0.52
   * 
   * @example
   * ```typescript
   * const price = Price.fromNumber(0.5234);
   * const rounded = price.toTick(0.01);
   * console.log(rounded.value); // 0.52
   * ```
   */
  public toTick(tickSize: number = Price.DEFAULT_TICK): Price {
    const rounded = Math.round(this.value / tickSize) * tickSize;
    const fixed = Number(rounded.toFixed(this.getDecimalPlaces(tickSize)));
    return Price.fromNumber(
      Math.max(Price.MIN_PRICE, Math.min(Price.MAX_PRICE, fixed))
    );
  }

  /**
   * Floors to tick size
   * 
   * @param tickSize - Tick size
   * @returns New Price floored to tick
   */
  public floorToTick(tickSize: number = Price.DEFAULT_TICK): Price {
    const floored = Math.floor(this.value / tickSize) * tickSize;
    const fixed = Number(floored.toFixed(this.getDecimalPlaces(tickSize)));
    return Price.fromNumber(Math.max(Price.MIN_PRICE, fixed));
  }

  /**
   * Ceils to tick size
   * 
   * @param tickSize - Tick size
   * @returns New Price ceiled to tick
   */
  public ceilToTick(tickSize: number = Price.DEFAULT_TICK): Price {
    const ceiled = Math.ceil(this.value / tickSize) * tickSize;
    const fixed = Number(ceiled.toFixed(this.getDecimalPlaces(tickSize)));
    return Price.fromNumber(Math.min(Price.MAX_PRICE, fixed));
  }

  /**
   * Adds to price
   * 
   * @param amount - Amount to add
   * @returns New Price
   */
  public add(amount: number): Price {
    return Price.fromNumber(
      Math.min(Price.MAX_PRICE, this.value + amount)
    );
  }

  /**
   * Subtracts from price
   * 
   * @param amount - Amount to subtract
   * @returns New Price
   */
  public subtract(amount: number): Price {
    return Price.fromNumber(
      Math.max(Price.MIN_PRICE, this.value - amount)
    );
  }

  /**
   * Multiplies price by factor
   * 
   * @param factor - Multiplication factor
   * @returns New Price
   */
  public multiply(factor: number): Price {
    return Price.fromNumber(
      Math.max(Price.MIN_PRICE, Math.min(Price.MAX_PRICE, this.value * factor))
    );
  }

  /**
   * Checks if price is greater than other
   * 
   * @param other - Price to compare
   * @returns True if greater
   */
  public isGreaterThan(other: Price): boolean {
    return this.value > other.value;
  }

  /**
   * Checks if price is less than other
   * 
   * @param other - Price to compare
   * @returns True if less
   */
  public isLessThan(other: Price): boolean {
    return this.value < other.value;
  }

  /**
   * Checks if prices are equal
   * 
   * @param other - Price to compare
   * @returns True if equal (within epsilon)
   */
  public equals(other: Price): boolean {
    return Math.abs(this.value - other.value) < 0.0000001;
  }

  /**
   * Converts to string
   * 
   * @param decimals - Number of decimals
   * @returns Formatted string
   */
  public toString(decimals: number = 4): string {
    return this.value.toFixed(decimals);
  }

  /**
   * Converts to percentage string
   * 
   * @returns Percentage string (e.g., "52.34%")
   */
  public toPercentage(): string {
    return `${(this.value * 100).toFixed(2)}%`;
  }

  private getDecimalPlaces(tickSize: number): number {
    const str = tickSize.toString();
    const decimalIndex = str.indexOf('.');
    return decimalIndex === -1 ? 0 : str.length - decimalIndex - 1;
  }

  public static get minPrice(): number {
    return Price.MIN_PRICE;
  }

  public static get maxPrice(): number {
    return Price.MAX_PRICE;
  }
}
