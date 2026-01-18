/**
 * Money value object
 * 
 * @remarks
 * Represents a monetary amount with currency.
 * Immutable value object for financial calculations.
 * 
 * Algorithm:
 * - Stores amount as number with fixed precision
 * - Provides arithmetic operations (add, subtract, multiply, divide)
 * - Validates amount is non-negative
 * - Ensures precision in calculations
 * 
 * @example
 * ```typescript
 * const money = Money.fromUSDC(100.50);
 * const doubled = money.multiply(2);
 * console.log(doubled.amount); // 201.00
 * ```
 */
export class Money {
  public readonly amount: number;
  public readonly currency: string;

  private constructor(amount: number, currency: string) {
    this.amount = Number(amount.toFixed(6)); // 6 decimal precision
    this.currency = currency;
  }

  /**
   * Creates Money from USDC amount
   *
   * @param amount - Amount in USDC (must be non-negative)
   * @returns Money instance
   * @throws {Error} If amount is negative
   *
   * @example
   * ```typescript
   * const money = Money.fromUSDC(100);
   * ```
   */
  public static fromUSDC(amount: number): Money {
    if (amount < 0) {
      throw new Error(`Amount cannot be negative: ${amount}`);
    }
    return new Money(amount, 'USDC');
  }

  /**
   * Creates Money from signed USDC amount (can be negative)
   *
   * @param amount - Amount in USDC (can be negative for PnL)
   * @returns Money instance
   *
   * @remarks
   * Used for PnL calculations where negative values represent losses.
   *
   * @example
   * ```typescript
   * const profit = Money.fromSignedUSDC(10.5);   // profit
   * const loss = Money.fromSignedUSDC(-5.2);     // loss
   * ```
   */
  public static fromSignedUSDC(amount: number): Money {
    return new Money(amount, 'USDC');
  }

  /**
   * Creates zero money
   * 
   * @returns Money instance with zero amount
   */
  public static zero(): Money {
    return new Money(0, 'USDC');
  }

  /**
   * Adds two money values
   * 
   * @param other - Money to add
   * @returns New Money instance with sum
   * @throws {Error} If currencies don't match
   */
  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  /**
   * Subtracts money value
   * 
   * @param other - Money to subtract
   * @returns New Money instance with difference
   * @throws {Error} If currencies don't match or result is negative
   */
  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.amount - other.amount;
    if (result < 0) {
      throw new Error(`Cannot subtract: result would be negative (${result})`);
    }
    return new Money(result, this.currency);
  }

  /**
   * Multiplies by a factor
   * 
   * @param factor - Multiplication factor
   * @returns New Money instance
   */
  public multiply(factor: number): Money {
    return new Money(this.amount * factor, this.currency);
  }

  /**
   * Divides by a factor
   * 
   * @param divisor - Division factor
   * @returns New Money instance
   * @throws {Error} If divisor is zero
   */
  public divide(divisor: number): Money {
    if (divisor === 0) {
      throw new Error('Cannot divide by zero');
    }
    return new Money(this.amount / divisor, this.currency);
  }

  /**
   * Checks if this money is greater than other
   * 
   * @param other - Money to compare
   * @returns True if greater
   */
  public isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount > other.amount;
  }

  /**
   * Checks if this money is less than other
   * 
   * @param other - Money to compare
   * @returns True if less
   */
  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount < other.amount;
  }

  /**
   * Checks if this money equals other
   * 
   * @param other - Money to compare
   * @returns True if equal
   */
  public equals(other: Money): boolean {
    return this.currency === other.currency && 
           Math.abs(this.amount - other.amount) < 0.000001;
  }

  /**
   * Checks if amount is zero
   * 
   * @returns True if zero
   */
  public isZero(): boolean {
    return this.amount === 0;
  }

  /**
   * Checks if amount is positive
   * 
   * @returns True if positive
   */
  public isPositive(): boolean {
    return this.amount > 0;
  }

  /**
   * Formats as string
   * 
   * @param decimals - Number of decimal places
   * @returns Formatted string
   */
  public toString(decimals: number = 2): string {
    return `$${this.amount.toFixed(decimals)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} vs ${other.currency}`
      );
    }
  }
}
