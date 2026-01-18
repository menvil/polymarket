/**
 * Percentage value object
 *
 * @remarks
 * Represents a percentage value in the range [0, 100].
 * Immutable value object with validation, arithmetic operations, and formatting.
 * Used for representing gains, losses, fees, and other percentage-based metrics.
 *
 * Algorithm:
 * 1. Validates that value is finite and within [0, 100] range
 * 2. Stores value as decimal percentage (e.g., 50 for 50%)
 * 3. Provides conversion to/from decimal (0.5 for 50%) and basis points
 * 4. All arithmetic operations return new Percentage instances (immutability)
 * 5. Supports comparison operations with epsilon for floating-point equality
 *
 * @example
 * ```typescript
 * const fee = Percentage.fromNumber(2.5); // 2.5%
 * const gain = Percentage.fromDecimal(0.15); // 15%
 * const total = fee.add(gain); // 17.5%
 * console.log(total.toDecimal()); // 0.175
 * console.log(total.toString()); // "17.50%"
 * ```
 */
import { TradingError } from '../../shared/errors/TradingError.js';

/**
 * Invalid percentage error
 *
 * @remarks
 * Thrown when percentage value is outside valid range [0, 100] or is not a finite number.
 */
export class InvalidPercentageError extends TradingError {
  constructor(public readonly percentage: number) {
    super(
      `Invalid percentage: ${percentage}. Must be between 0 and 100`,
      'INVALID_PERCENTAGE'
    );
  }
}

export class Percentage {
  public readonly value: number;

  private static readonly MIN_PERCENTAGE = 0;
  private static readonly MAX_PERCENTAGE = 100;
  private static readonly EPSILON = 0.0001;

  private constructor(value: number) {
    this.value = value;
  }

  /**
   * Creates Percentage from number (0-100 scale)
   *
   * @param value - Percentage value [0, 100]
   * @returns Percentage instance
   * @throws {InvalidPercentageError} If percentage is out of range or not finite
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(25.5); // 25.5%
   * ```
   */
  public static fromNumber(value: number): Percentage {
    if (!Percentage.isValid(value)) {
      throw new InvalidPercentageError(value);
    }
    return new Percentage(value);
  }

  /**
   * Creates Percentage from decimal (0-1 scale)
   *
   * @param decimal - Decimal value [0, 1]
   * @returns Percentage instance
   * @throws {InvalidPercentageError} If decimal is out of range
   *
   * @remarks
   * Converts decimal representation to percentage.
   * Example: 0.5 becomes 50%, 0.025 becomes 2.5%
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromDecimal(0.5); // 50%
   * const fee = Percentage.fromDecimal(0.025); // 2.5%
   * ```
   */
  public static fromDecimal(decimal: number): Percentage {
    const percentage = decimal * 100;
    if (!Percentage.isValid(percentage)) {
      throw new InvalidPercentageError(percentage);
    }
    return new Percentage(percentage);
  }

  /**
   * Creates Percentage from basis points
   *
   * @param bps - Basis points (1 bp = 0.01%)
   * @returns Percentage instance
   * @throws {InvalidPercentageError} If resulting percentage is out of range
   *
   * @remarks
   * Converts basis points to percentage.
   * Example: 100 bps = 1%, 250 bps = 2.5%
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromBasisPoints(250); // 2.5%
   * ```
   */
  public static fromBasisPoints(bps: number): Percentage {
    const percentage = bps / 100;
    if (!Percentage.isValid(percentage)) {
      throw new InvalidPercentageError(percentage);
    }
    return new Percentage(percentage);
  }

  /**
   * Creates Percentage from string
   *
   * @param value - Percentage as string (with or without '%' symbol)
   * @returns Percentage instance
   * @throws {InvalidPercentageError} If string is invalid
   *
   * @example
   * ```typescript
   * const pct1 = Percentage.fromString("25.5"); // 25.5%
   * const pct2 = Percentage.fromString("25.5%"); // 25.5%
   * ```
   */
  public static fromString(value: string): Percentage {
    const cleaned = value.replace('%', '').trim();
    const numValue = parseFloat(cleaned);
    if (isNaN(numValue)) {
      throw new InvalidPercentageError(NaN);
    }
    return Percentage.fromNumber(numValue);
  }

  /**
   * Creates zero percentage
   *
   * @returns Percentage with 0% value
   *
   * @example
   * ```typescript
   * const zero = Percentage.zero();
   * console.log(zero.value); // 0
   * ```
   */
  public static zero(): Percentage {
    return new Percentage(0);
  }

  /**
   * Creates 100% percentage
   *
   * @returns Percentage with 100% value
   *
   * @example
   * ```typescript
   * const max = Percentage.oneHundred();
   * console.log(max.value); // 100
   * ```
   */
  public static oneHundred(): Percentage {
    return new Percentage(100);
  }

  /**
   * Validates percentage value
   *
   * @param value - Value to validate
   * @returns True if valid
   *
   * @remarks
   * Valid percentage must be:
   * - A finite number
   * - Between 0 and 100 (inclusive)
   */
  public static isValid(value: number): boolean {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= Percentage.MIN_PERCENTAGE &&
      value <= Percentage.MAX_PERCENTAGE
    );
  }

  /**
   * Converts to decimal (0-1 scale)
   *
   * @returns Decimal representation
   *
   * @remarks
   * Converts percentage to decimal for calculations.
   * Example: 50% becomes 0.5, 2.5% becomes 0.025
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(50);
   * console.log(pct.toDecimal()); // 0.5
   * ```
   */
  public toDecimal(): number {
    return this.value / 100;
  }

  /**
   * Converts to basis points
   *
   * @returns Basis points (1 bp = 0.01%)
   *
   * @remarks
   * Converts percentage to basis points.
   * Example: 2.5% becomes 250 bps, 1% becomes 100 bps
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(2.5);
   * console.log(pct.toBasisPoints()); // 250
   * ```
   */
  public toBasisPoints(): number {
    return this.value * 100;
  }

  /**
   * Adds percentages
   *
   * @param other - Percentage to add
   * @returns New Percentage clamped to [0, 100]
   *
   * @remarks
   * Adds two percentages together, clamping result to max 100%
   *
   * @example
   * ```typescript
   * const fee = Percentage.fromNumber(2.5);
   * const gain = Percentage.fromNumber(15);
   * const total = fee.add(gain); // 17.5%
   * ```
   */
  public add(other: Percentage): Percentage {
    return new Percentage(
      Math.min(Percentage.MAX_PERCENTAGE, this.value + other.value)
    );
  }

  /**
   * Subtracts percentage
   *
   * @param other - Percentage to subtract
   * @returns New Percentage clamped to [0, 100]
   *
   * @remarks
   * Subtracts percentage, clamping result to min 0%
   *
   * @example
   * ```typescript
   * const total = Percentage.fromNumber(17.5);
   * const fee = Percentage.fromNumber(2.5);
   * const net = total.subtract(fee); // 15%
   * ```
   */
  public subtract(other: Percentage): Percentage {
    return new Percentage(
      Math.max(Percentage.MIN_PERCENTAGE, this.value - other.value)
    );
  }

  /**
   * Multiplies by factor
   *
   * @param factor - Multiplication factor
   * @returns New Percentage clamped to [0, 100]
   *
   * @remarks
   * Multiplies percentage by a factor, clamping to valid range
   *
   * @example
   * ```typescript
   * const base = Percentage.fromNumber(10);
   * const doubled = base.multiply(2); // 20%
   * ```
   */
  public multiply(factor: number): Percentage {
    const result = this.value * factor;
    return new Percentage(
      Math.max(
        Percentage.MIN_PERCENTAGE,
        Math.min(Percentage.MAX_PERCENTAGE, result)
      )
    );
  }

  /**
   * Divides by factor
   *
   * @param divisor - Division factor
   * @returns New Percentage
   * @throws {Error} If divisor is zero
   *
   * @remarks
   * Divides percentage by a factor
   *
   * @example
   * ```typescript
   * const total = Percentage.fromNumber(20);
   * const half = total.divide(2); // 10%
   * ```
   */
  public divide(divisor: number): Percentage {
    if (divisor === 0) {
      throw new Error('Cannot divide by zero');
    }
    return new Percentage(this.value / divisor);
  }

  /**
   * Applies percentage to a value
   *
   * @param value - Base value
   * @returns Calculated amount (value * percentage)
   *
   * @remarks
   * Calculates the percentage amount of a value.
   * Example: 10% of 1000 = 100
   *
   * @example
   * ```typescript
   * const fee = Percentage.fromNumber(2.5);
   * const orderValue = 1000;
   * const feeAmount = fee.of(orderValue); // 25
   * ```
   */
  public of(value: number): number {
    return value * this.toDecimal();
  }

  /**
   * Checks if greater than other
   *
   * @param other - Percentage to compare
   * @returns True if greater
   *
   * @example
   * ```typescript
   * const a = Percentage.fromNumber(15);
   * const b = Percentage.fromNumber(10);
   * console.log(a.isGreaterThan(b)); // true
   * ```
   */
  public isGreaterThan(other: Percentage): boolean {
    return this.value > other.value;
  }

  /**
   * Checks if less than other
   *
   * @param other - Percentage to compare
   * @returns True if less
   *
   * @example
   * ```typescript
   * const a = Percentage.fromNumber(10);
   * const b = Percentage.fromNumber(15);
   * console.log(a.isLessThan(b)); // true
   * ```
   */
  public isLessThan(other: Percentage): boolean {
    return this.value < other.value;
  }

  /**
   * Checks if percentages are equal
   *
   * @param other - Percentage to compare
   * @returns True if equal (within epsilon)
   *
   * @remarks
   * Uses epsilon comparison for floating-point equality
   *
   * @example
   * ```typescript
   * const a = Percentage.fromNumber(10.0001);
   * const b = Percentage.fromNumber(10.0000);
   * console.log(a.equals(b)); // true (within epsilon)
   * ```
   */
  public equals(other: Percentage): boolean {
    return Math.abs(this.value - other.value) < Percentage.EPSILON;
  }

  /**
   * Checks if zero
   *
   * @returns True if zero
   *
   * @example
   * ```typescript
   * const zero = Percentage.zero();
   * console.log(zero.isZero()); // true
   * ```
   */
  public isZero(): boolean {
    return Math.abs(this.value) < Percentage.EPSILON;
  }

  /**
   * Checks if positive
   *
   * @returns True if positive (> 0)
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(5);
   * console.log(pct.isPositive()); // true
   * ```
   */
  public isPositive(): boolean {
    return this.value > Percentage.EPSILON;
  }

  /**
   * Converts to string with percentage symbol
   *
   * @param decimals - Number of decimal places (default 2)
   * @returns Formatted string (e.g., "25.50%")
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(25.5);
   * console.log(pct.toString()); // "25.50%"
   * console.log(pct.toString(1)); // "25.5%"
   * ```
   */
  public toString(decimals: number = 2): string {
    return `${this.value.toFixed(decimals)}%`;
  }

  /**
   * Converts to plain number string
   *
   * @param decimals - Number of decimal places (default 2)
   * @returns Formatted number string (e.g., "25.50")
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(25.5);
   * console.log(pct.toNumber()); // "25.50"
   * ```
   */
  public toNumber(decimals: number = 2): string {
    return this.value.toFixed(decimals);
  }

  public static get minPercentage(): number {
    return Percentage.MIN_PERCENTAGE;
  }

  public static get maxPercentage(): number {
    return Percentage.MAX_PERCENTAGE;
  }
}
