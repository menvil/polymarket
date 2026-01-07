/**
 * Spread value object
 *
 * @remarks
 * Represents a bid-ask spread in prediction markets.
 * Immutable value object that encapsulates bid and ask prices with validation.
 * The spread width represents the difference between ask and bid prices.
 *
 * Algorithm:
 * 1. Validates that bid price is less than or equal to ask price
 * 2. Stores both bid and ask as Price value objects
 * 3. Calculates spread width as (ask - bid)
 * 4. Calculates midpoint as (bid + ask) / 2
 * 5. All operations return new Spread instances (immutability)
 * 6. Provides percentage-based spread width calculation
 *
 * @example
 * ```typescript
 * const bid = Price.fromNumber(0.48);
 * const ask = Price.fromNumber(0.52);
 * const spread = Spread.create(bid, ask);
 * console.log(spread.width()); // 0.04
 * console.log(spread.midpoint().value); // 0.50
 * console.log(spread.widthPercentage().value); // 8%
 * ```
 */
import { Price } from './Price.js';
import { Percentage } from './Percentage.js';
import { TradingError } from '../../shared/errors/TradingError.js';

/**
 * Invalid spread error
 *
 * @remarks
 * Thrown when spread is invalid (bid > ask).
 */
export class InvalidSpreadError extends TradingError {
  constructor(
    public readonly bid: number,
    public readonly ask: number
  ) {
    super(
      `Invalid spread: bid (${bid}) must be <= ask (${ask})`,
      'INVALID_SPREAD'
    );
  }
}

export class Spread {
  public readonly bid: Price;
  public readonly ask: Price;

  private static readonly EPSILON = 0.0001;

  private constructor(bid: Price, ask: Price) {
    this.bid = bid;
    this.ask = ask;
  }

  /**
   * Creates Spread from bid and ask prices
   *
   * @param bid - Bid price
   * @param ask - Ask price
   * @returns Spread instance
   * @throws {InvalidSpreadError} If bid > ask
   *
   * @remarks
   * Validates that bid <= ask. In prediction markets:
   * - Bid is the highest price buyers are willing to pay
   * - Ask is the lowest price sellers are willing to accept
   * - Ask must be >= bid (no crossed markets)
   *
   * @example
   * ```typescript
   * const bid = Price.fromNumber(0.48);
   * const ask = Price.fromNumber(0.52);
   * const spread = Spread.create(bid, ask);
   * ```
   */
  public static create(bid: Price, ask: Price): Spread {
    if (!Spread.isValid(bid, ask)) {
      throw new InvalidSpreadError(bid.value, ask.value);
    }
    return new Spread(bid, ask);
  }

  /**
   * Creates Spread from bid and ask numbers
   *
   * @param bid - Bid price value
   * @param ask - Ask price value
   * @returns Spread instance
   * @throws {InvalidPriceError} If prices are invalid
   * @throws {InvalidSpreadError} If bid > ask
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * ```
   */
  public static fromNumbers(bid: number, ask: number): Spread {
    const bidPrice = Price.fromNumber(bid);
    const askPrice = Price.fromNumber(ask);
    return Spread.create(bidPrice, askPrice);
  }

  /**
   * Creates zero-width spread (bid = ask)
   *
   * @param price - Price for both bid and ask
   * @returns Spread with zero width
   *
   * @remarks
   * Zero-width spread indicates a perfectly liquid market
   * where bid and ask prices are the same.
   *
   * @example
   * ```typescript
   * const price = Price.fromNumber(0.50);
   * const spread = Spread.zero(price);
   * console.log(spread.width()); // 0
   * ```
   */
  public static zero(price: Price): Spread {
    return new Spread(price, price);
  }

  /**
   * Validates spread
   *
   * @param bid - Bid price
   * @param ask - Ask price
   * @returns True if valid (bid <= ask)
   *
   * @remarks
   * A valid spread requires bid <= ask.
   * Equal prices (bid = ask) represent zero spread.
   */
  public static isValid(bid: Price, ask: Price): boolean {
    return bid.value <= ask.value;
  }

  /**
   * Calculates spread width
   *
   * @returns Spread width (ask - bid)
   *
   * @remarks
   * Width represents the liquidity cost.
   * Narrower spreads indicate more liquid markets.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * console.log(spread.width()); // 0.04
   * ```
   */
  public width(): number {
    return this.ask.value - this.bid.value;
  }

  /**
   * Calculates spread width as Percentage
   *
   * @returns Spread width percentage relative to midpoint
   *
   * @remarks
   * Calculates: (width / midpoint) * 100
   * This normalizes spread for comparison across different price levels.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * const widthPct = spread.widthPercentage();
   * console.log(widthPct.value); // 8%
   * // Calculation: (0.04 / 0.50) * 100 = 8%
   * ```
   */
  public widthPercentage(): Percentage {
    const mid = this.midpoint().value;
    if (mid === 0) {
      return Percentage.zero();
    }
    const widthPct = (this.width() / mid) * 100;
    return Percentage.fromNumber(widthPct);
  }

  /**
   * Calculates midpoint price
   *
   * @returns Midpoint price (average of bid and ask)
   *
   * @remarks
   * Midpoint represents the theoretical "fair" price.
   * Often used as reference price for analytics.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * const mid = spread.midpoint();
   * console.log(mid.value); // 0.50
   * ```
   */
  public midpoint(): Price {
    const midValue = (this.bid.value + this.ask.value) / 2;
    return Price.fromNumber(midValue);
  }

  /**
   * Checks if spread is zero-width
   *
   * @returns True if bid equals ask (within epsilon)
   *
   * @remarks
   * Zero-width spread indicates perfect liquidity at this price level.
   *
   * @example
   * ```typescript
   * const spread1 = Spread.fromNumbers(0.50, 0.50);
   * console.log(spread1.isZeroWidth()); // true
   *
   * const spread2 = Spread.fromNumbers(0.48, 0.52);
   * console.log(spread2.isZeroWidth()); // false
   * ```
   */
  public isZeroWidth(): boolean {
    return Math.abs(this.width()) < Spread.EPSILON;
  }

  /**
   * Checks if spread is wide
   *
   * @param threshold - Width threshold (default 0.05 = 5 cents)
   * @returns True if width exceeds threshold
   *
   * @remarks
   * Wide spreads indicate low liquidity or high uncertainty.
   * Common threshold is 0.05 (5 cents) for prediction markets.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.45, 0.55);
   * console.log(spread.isWide()); // true (width = 0.10 > 0.05)
   * console.log(spread.isWide(0.15)); // false (width = 0.10 < 0.15)
   * ```
   */
  public isWide(threshold: number = 0.05): boolean {
    return this.width() > threshold;
  }

  /**
   * Tightens spread by moving bid/ask closer
   *
   * @param amount - Amount to tighten (reduce width by 2x this amount)
   * @returns New Spread with tightened width
   *
   * @remarks
   * Moves bid up and ask down by the specified amount.
   * Useful for market making strategies.
   * If amount would cross the spread, returns zero-width spread at midpoint.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * const tightened = spread.tighten(0.01);
   * console.log(tightened.bid.value); // 0.49
   * console.log(tightened.ask.value); // 0.51
   * console.log(tightened.width()); // 0.02
   * ```
   */
  public tighten(amount: number): Spread {
    const halfWidth = this.width() / 2;
    const tightenAmount = Math.min(amount, halfWidth);

    const newBid = this.bid.add(tightenAmount);
    const newAsk = this.ask.subtract(tightenAmount);

    return Spread.create(newBid, newAsk);
  }

  /**
   * Widens spread by moving bid/ask apart
   *
   * @param amount - Amount to widen (increase width by 2x this amount)
   * @returns New Spread with widened width
   *
   * @remarks
   * Moves bid down and ask up by the specified amount.
   * Respects price boundaries [0.01, 0.99].
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * const widened = spread.widen(0.02);
   * console.log(widened.bid.value); // 0.46
   * console.log(widened.ask.value); // 0.54
   * console.log(widened.width()); // 0.08
   * ```
   */
  public widen(amount: number): Spread {
    const newBid = this.bid.subtract(amount);
    const newAsk = this.ask.add(amount);
    return Spread.create(newBid, newAsk);
  }

  /**
   * Shifts spread up or down
   *
   * @param amount - Amount to shift (positive = up, negative = down)
   * @returns New Spread shifted by amount
   *
   * @remarks
   * Moves both bid and ask by the same amount.
   * Preserves spread width. Respects price boundaries.
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * const shifted = spread.shift(0.05);
   * console.log(shifted.bid.value); // 0.53
   * console.log(shifted.ask.value); // 0.57
   * console.log(shifted.width()); // 0.04 (unchanged)
   * ```
   */
  public shift(amount: number): Spread {
    const newBid = amount >= 0 ? this.bid.add(amount) : this.bid.subtract(Math.abs(amount));
    const newAsk = amount >= 0 ? this.ask.add(amount) : this.ask.subtract(Math.abs(amount));
    return Spread.create(newBid, newAsk);
  }

  /**
   * Checks if price is within spread
   *
   * @param price - Price to check
   * @returns True if bid <= price <= ask
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * console.log(spread.contains(Price.fromNumber(0.50))); // true
   * console.log(spread.contains(Price.fromNumber(0.55))); // false
   * ```
   */
  public contains(price: Price): boolean {
    return price.value >= this.bid.value && price.value <= this.ask.value;
  }

  /**
   * Checks if spreads are equal
   *
   * @param other - Spread to compare
   * @returns True if both bid and ask are equal
   *
   * @example
   * ```typescript
   * const s1 = Spread.fromNumbers(0.48, 0.52);
   * const s2 = Spread.fromNumbers(0.48, 0.52);
   * console.log(s1.equals(s2)); // true
   * ```
   */
  public equals(other: Spread): boolean {
    return this.bid.equals(other.bid) && this.ask.equals(other.ask);
  }

  /**
   * Converts to string representation
   *
   * @returns String in format "bid-ask (width)"
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * console.log(spread.toString()); // "0.4800-0.5200 (0.0400)"
   * ```
   */
  public toString(): string {
    return `${this.bid.toString()}-${this.ask.toString()} (${this.width().toFixed(4)})`;
  }

  /**
   * Converts to object representation
   *
   * @returns Object with bid, ask, width, and midpoint
   *
   * @example
   * ```typescript
   * const spread = Spread.fromNumbers(0.48, 0.52);
   * console.log(spread.toObject());
   * // {
   * //   bid: 0.48,
   * //   ask: 0.52,
   * //   width: 0.04,
   * //   midpoint: 0.50
   * // }
   * ```
   */
  public toObject(): { bid: number; ask: number; width: number; midpoint: number } {
    return {
      bid: this.bid.value,
      ask: this.ask.value,
      width: this.width(),
      midpoint: this.midpoint().value,
    };
  }
}
