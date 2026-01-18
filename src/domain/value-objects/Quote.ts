/**
 * Quote - котировка маркет-мейкера
 *
 * @remarks
 * Value Object представляющий двухстороннюю котировку (bid/ask).
 *
 * Структура котировки:
 * - bid: цена покупки (lower)
 * - ask: цена продажи (higher)
 * - bidSize: объем на bid
 * - askSize: объем на ask
 * - spread: ask - bid
 *
 * Зачем нужен Quote?
 * - Инкапсуляция котировки как единого объекта
 * - Валидация (bid < ask, positive sizes)
 * - Расчет спреда и mid-price
 * - Проверка crossing (самоисполнение)
 *
 * @example
 * ```typescript
 * const quote = new Quote(
 *   Price.fromNumber(0.64),      // bid
 *   Price.fromNumber(0.66),      // ask
 *   Quantity.fromNumber(100),    // bidSize
 *   Quantity.fromNumber(100),    // askSize
 *   new Date()
 * );
 *
 * console.log(quote.getSpread()); // 0.02
 * console.log(quote.getMidPrice().value); // 0.65
 * ```
 */
import { Price } from './Price.js';
import { Quantity } from './Quantity.js';

/**
 * Quote value object
 *
 * @remarks
 * Иммутабельный value object для котировок.
 * Bid и Ask могут быть null (one-sided quote).
 */
export class Quote {
  /**
   * Creates a Quote
   *
   * @param bid - Bid price (null for ask-only quote)
   * @param ask - Ask price (null for bid-only quote)
   * @param bidSize - Bid quantity
   * @param askSize - Ask quantity
   * @param timestamp - Quote timestamp (default: now)
   *
   * @throws {Error} If bid >= ask (when both present)
   * @throws {Error} If sizes are not positive
   *
   * @example
   * ```typescript
   * // Two-sided quote
   * const quote1 = new Quote(
   *   Price.fromNumber(0.64),
   *   Price.fromNumber(0.66),
   *   Quantity.fromNumber(100),
   *   Quantity.fromNumber(100)
   * );
   *
   * // Bid-only quote
   * const quote2 = new Quote(
   *   Price.fromNumber(0.64),
   *   null,
   *   Quantity.fromNumber(100),
   *   Quantity.fromNumber(0)
   * );
   *
   * // Ask-only quote
   * const quote3 = new Quote(
   *   null,
   *   Price.fromNumber(0.66),
   *   Quantity.fromNumber(0),
   *   Quantity.fromNumber(100)
   * );
   * ```
   */
  constructor(
    public readonly bid: Price | null,
    public readonly ask: Price | null,
    public readonly bidSize: Quantity,
    public readonly askSize: Quantity,
    public readonly timestamp: Date = new Date()
  ) {
    this.validate();
  }

  /**
   * Validates quote
   *
   * @throws {Error} If validation fails
   *
   * @remarks
   * Проверки:
   * 1. Хотя бы одна сторона должна быть не null
   * 2. Если обе стороны присутствуют: bid < ask
   * 3. Sizes должны быть >= 0
   * 4. Если bid/ask null, соответствующий size должен быть 0
   */
  private validate(): void {
    // At least one side must be present
    if (!this.bid && !this.ask) {
      throw new Error('Quote must have at least bid or ask');
    }

    // Bid must be less than ask
    if (this.bid && this.ask && this.bid.value >= this.ask.value) {
      throw new Error(
        `Bid ${this.bid.value} must be less than ask ${this.ask.value}`
      );
    }

    // Sizes must be non-negative
    if (this.bidSize.value < 0 || this.askSize.value < 0) {
      throw new Error('Quote sizes must be non-negative');
    }

    // If bid is null, bidSize should be 0
    if (!this.bid && this.bidSize.value > 0) {
      throw new Error('Bid size must be 0 when bid price is null');
    }

    // If ask is null, askSize should be 0
    if (!this.ask && this.askSize.value > 0) {
      throw new Error('Ask size must be 0 when ask price is null');
    }
  }

  /**
   * Calculates spread
   *
   * @returns Spread (ask - bid)
   *
   * @throws {Error} If quote is one-sided
   *
   * @remarks
   * spread = ask - bid
   *
   * @example
   * ```typescript
   * const quote = new Quote(
   *   Price.fromNumber(0.64),
   *   Price.fromNumber(0.66),
   *   ...
   * );
   *
   * const spread = quote.getSpread();
   * console.log(spread); // 0.02
   * ```
   */
  public getSpread(): number {
    if (!this.bid || !this.ask) {
      throw new Error('Cannot calculate spread for one-sided quote');
    }
    return this.ask.value - this.bid.value;
  }

  /**
   * Calculates mid-price
   *
   * @returns Mid-price ((bid + ask) / 2)
   *
   * @throws {Error} If quote is one-sided
   *
   * @remarks
   * midPrice = (bid + ask) / 2
   *
   * @example
   * ```typescript
   * const quote = new Quote(
   *   Price.fromNumber(0.64),
   *   Price.fromNumber(0.66),
   *   ...
   * );
   *
   * const mid = quote.getMidPrice();
   * console.log(mid.value); // 0.65
   * ```
   */
  public getMidPrice(): Price {
    if (!this.bid || !this.ask) {
      throw new Error('Cannot calculate mid-price for one-sided quote');
    }
    return Price.fromNumber((this.bid.value + this.ask.value) / 2);
  }

  /**
   * Checks if quote is two-sided
   *
   * @returns True if both bid and ask are present
   *
   * @example
   * ```typescript
   * const quote1 = new Quote(Price.fromNumber(0.64), Price.fromNumber(0.66), ...);
   * console.log(quote1.isTwoSided()); // true
   *
   * const quote2 = new Quote(Price.fromNumber(0.64), null, ...);
   * console.log(quote2.isTwoSided()); // false
   * ```
   */
  public isTwoSided(): boolean {
    return this.bid !== null && this.ask !== null;
  }

  /**
   * Checks if quote is bid-only
   *
   * @returns True if only bid is present
   *
   * @example
   * ```typescript
   * const quote = new Quote(Price.fromNumber(0.64), null, ...);
   * console.log(quote.isBidOnly()); // true
   * ```
   */
  public isBidOnly(): boolean {
    return this.bid !== null && this.ask === null;
  }

  /**
   * Checks if quote is ask-only
   *
   * @returns True if only ask is present
   *
   * @example
   * ```typescript
   * const quote = new Quote(null, Price.fromNumber(0.66), ...);
   * console.log(quote.isAskOnly()); // true
   * ```
   */
  public isAskOnly(): boolean {
    return this.bid === null && this.ask !== null;
  }

  /**
   * Checks if quote would cross with orderbook prices
   *
   * @param orderbookBid - Best bid from orderbook
   * @param orderbookAsk - Best ask from orderbook
   * @returns True if quote would immediately execute
   *
   * @remarks
   * Crossing occurs when:
   * - Our bid >= orderbook ask (would buy immediately)
   * - Our ask <= orderbook bid (would sell immediately)
   *
   * @example
   * ```typescript
   * const quote = new Quote(
   *   Price.fromNumber(0.67),  // our bid
   *   Price.fromNumber(0.68),
   *   ...
   * );
   *
   * const crosses = quote.crossesMarket(
   *   Price.fromNumber(0.65),  // orderbook bid
   *   Price.fromNumber(0.66)   // orderbook ask
   * );
   * console.log(crosses); // true (our bid 0.67 >= orderbook ask 0.66)
   * ```
   */
  public crossesMarket(orderbookBid: Price | null, orderbookAsk: Price | null): boolean {
    // Our bid crosses if it's >= orderbook ask
    if (this.bid && orderbookAsk && this.bid.value >= orderbookAsk.value) {
      return true;
    }

    // Our ask crosses if it's <= orderbook bid
    if (this.ask && orderbookBid && this.ask.value <= orderbookBid.value) {
      return true;
    }

    return false;
  }

  /**
   * Creates a copy with adjusted prices
   *
   * @param bidAdjustment - Amount to add/subtract from bid
   * @param askAdjustment - Amount to add/subtract from ask
   * @returns New Quote with adjusted prices
   *
   * @remarks
   * Используется для skew adjustments в стратегиях.
   *
   * @example
   * ```typescript
   * const quote = new Quote(
   *   Price.fromNumber(0.64),
   *   Price.fromNumber(0.66),
   *   ...
   * );
   *
   * // Widen spread (move bid down, ask up)
   * const widened = quote.withAdjustment(-0.01, +0.01);
   * // bid: 0.63, ask: 0.67
   *
   * // Skew towards bid (inventory mgmt)
   * const skewed = quote.withAdjustment(-0.01, -0.01);
   * // bid: 0.63, ask: 0.65
   * ```
   */
  public withAdjustment(bidAdjustment: number, askAdjustment: number): Quote {
    const newBid = this.bid ? Price.fromNumber(this.bid.value + bidAdjustment) : null;
    const newAsk = this.ask ? Price.fromNumber(this.ask.value + askAdjustment) : null;

    return new Quote(newBid, newAsk, this.bidSize, this.askSize, new Date());
  }

  /**
   * String representation
   *
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * const quote = new Quote(...);
   * console.log(quote.toString());
   * // '0.64 (100) / 0.66 (100) [spread: 0.02]'
   * ```
   */
  public toString(): string {
    const bidStr = this.bid ? `${this.bid.value.toFixed(4)} (${this.bidSize.value})` : 'N/A';
    const askStr = this.ask ? `${this.ask.value.toFixed(4)} (${this.askSize.value})` : 'N/A';
    const spreadStr = this.isTwoSided() ? ` [spread: ${this.getSpread().toFixed(4)}]` : '';

    return `${bidStr} / ${askStr}${spreadStr}`;
  }

  /**
   * Checks equality with another quote
   *
   * @param other - Other quote to compare
   * @returns True if quotes are equal
   *
   * @remarks
   * Quotes are equal if bid, ask, and sizes are equal (timestamps ignored).
   *
   * @example
   * ```typescript
   * const quote1 = new Quote(...);
   * const quote2 = new Quote(...);
   * console.log(quote1.equals(quote2));
   * ```
   */
  public equals(other: Quote): boolean {
    const pricesEqual = (a: Price | null, b: Price | null): boolean =>
      a === b || (a !== null && b !== null && a.equals(b));

    return (
      pricesEqual(this.bid, other.bid) &&
      pricesEqual(this.ask, other.ask) &&
      this.bidSize.equals(other.bidSize) &&
      this.askSize.equals(other.askSize)
    );
  }
}
