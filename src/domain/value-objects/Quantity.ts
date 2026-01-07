/**
 * Quantity value object
 *
 * @remarks
 * Represents a quantity/size of shares in prediction markets.
 * Immutable value object with validation and rounding to tick size.
 *
 * @example
 * ```typescript
 * const qty = Quantity.fromNumber(10.5);
 * const rounded = qty.toTick(0.1);
 * console.log(rounded.value); // 10.5
 * ```
 */
import { InvalidQuantityError } from '../../shared/errors/TradingError.js';

export class Quantity {
  public readonly value: number;

  private static readonly MIN_SIZE = 0.1;
  private static readonly DEFAULT_TICK = 0.1;

  private constructor(value: number) {
    this.value = value;
  }

  /**
   * Creates Quantity from number
   *
   * @param value - Quantity value (must be >= MIN_SIZE)
   * @param minSize - Minimum size (default 0.1)
   * @returns Quantity instance
   * @throws {InvalidQuantityError} If quantity is invalid
   *
   * @example
   * ```typescript
   * const qty = Quantity.fromNumber(10);
   * ```
   */
  public static fromNumber(value: number, minSize: number = Quantity.MIN_SIZE): Quantity {
    if (!Quantity.isValid(value, minSize)) {
      throw new InvalidQuantityError(value, minSize);
    }
    return new Quantity(value);
  }

  /**
   * Creates zero quantity
   *
   * @returns Quantity with zero value
   */
  public static zero(): Quantity {
    return new Quantity(0);
  }

  /**
   * Creates Quantity from market data without minimum size validation
   *
   * @param value - Quantity value (must be >= 0)
   * @returns Quantity instance
   *
   * @remarks
   * Use this for incoming market data (trades, fills) where the exchange
   * may send quantities smaller than our MIN_SIZE for orders.
   * For creating orders, use `fromNumber()` which enforces MIN_SIZE.
   *
   * @example
   * ```typescript
   * // For incoming trade from exchange
   * const qty = Quantity.fromMarketData(0.07);
   * ```
   */
  public static fromMarketData(value: number): Quantity {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new InvalidQuantityError(value, 0);
    }
    return new Quantity(value);
  }

  /**
   * Validates quantity value
   *
   * @param value - Value to validate
   * @param minSize - Minimum size
   * @returns True if valid
   */
  public static isValid(value: number, minSize: number = Quantity.MIN_SIZE): boolean {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      (value === 0 || value >= minSize)
    );
  }

  /**
   * Rounds to tick size
   *
   * @param tickSize - Tick size (default 0.1)
   * @returns New Quantity rounded to tick
   *
   * @remarks
   * Rounds quantity to nearest tick size.
   *
   * @example
   * ```typescript
   * const qty = Quantity.fromNumber(10.567);
   * const rounded = qty.toTick(0.1);
   * console.log(rounded.value); // 10.6
   * ```
   */
  public toTick(tickSize: number = Quantity.DEFAULT_TICK): Quantity {
    const rounded = Math.round(this.value / tickSize) * tickSize;
    const fixed = Number(rounded.toFixed(this.getDecimalPlaces(tickSize)));
    return new Quantity(Math.max(0, fixed));
  }

  /**
   * Floors to tick size
   *
   * @param tickSize - Tick size
   * @returns New Quantity floored to tick
   */
  public floorToTick(tickSize: number = Quantity.DEFAULT_TICK): Quantity {
    const floored = Math.floor(this.value / tickSize) * tickSize;
    const fixed = Number(floored.toFixed(this.getDecimalPlaces(tickSize)));
    return new Quantity(Math.max(0, fixed));
  }

  /**
   * Ceils to tick size
   *
   * @param tickSize - Tick size
   * @returns New Quantity ceiled to tick
   */
  public ceilToTick(tickSize: number = Quantity.DEFAULT_TICK): Quantity {
    const ceiled = Math.ceil(this.value / tickSize) * tickSize;
    const fixed = Number(ceiled.toFixed(this.getDecimalPlaces(tickSize)));
    return new Quantity(fixed);
  }

  /**
   * Adds quantities
   *
   * @param other - Quantity to add
   * @returns New Quantity
   */
  public add(other: Quantity): Quantity {
    return new Quantity(this.value + other.value);
  }

  /**
   * Subtracts quantity
   *
   * @param other - Quantity to subtract
   * @returns New Quantity
   * @throws {Error} If result would be negative
   */
  public subtract(other: Quantity): Quantity {
    const result = this.value - other.value;
    if (result < 0) {
      throw new Error(`Cannot subtract: result would be negative (${result})`);
    }
    return new Quantity(result);
  }

  /**
   * Multiplies by factor
   *
   * @param factor - Multiplication factor
   * @returns New Quantity
   */
  public multiply(factor: number): Quantity {
    return new Quantity(Math.max(0, this.value * factor));
  }

  /**
   * Divides by factor
   *
   * @param divisor - Division factor
   * @returns New Quantity
   * @throws {Error} If divisor is zero
   */
  public divide(divisor: number): Quantity {
    if (divisor === 0) {
      throw new Error('Cannot divide by zero');
    }
    return new Quantity(this.value / divisor);
  }

  /**
   * Checks if greater than other
   *
   * @param other - Quantity to compare
   * @returns True if greater
   */
  public isGreaterThan(other: Quantity): boolean {
    return this.value > other.value;
  }

  /**
   * Checks if less than other
   *
   * @param other - Quantity to compare
   * @returns True if less
   */
  public isLessThan(other: Quantity): boolean {
    return this.value < other.value;
  }

  /**
   * Checks if equal
   *
   * @param other - Quantity to compare
   * @returns True if equal (within epsilon)
   */
  public equals(other: Quantity): boolean {
    return Math.abs(this.value - other.value) < 0.0001;
  }

  /**
   * Checks if zero
   *
   * @returns True if zero
   */
  public isZero(): boolean {
    return this.value === 0;
  }

  /**
   * Checks if positive
   *
   * @returns True if positive
   */
  public isPositive(): boolean {
    return this.value > 0;
  }

  /**
   * Converts to string
   *
   * @param decimals - Number of decimals
   * @returns Formatted string
   */
  public toString(decimals: number = 2): string {
    return this.value.toFixed(decimals);
  }

  private getDecimalPlaces(tickSize: number): number {
    const str = tickSize.toString();
    const decimalIndex = str.indexOf('.');
    return decimalIndex === -1 ? 0 : str.length - decimalIndex - 1;
  }

  public static get minSize(): number {
    return Quantity.MIN_SIZE;
  }
}
