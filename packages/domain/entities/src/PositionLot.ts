/**
 * PositionLot entity
 *
 * @remarks
 * Represents a single lot for FIFO (First In, First Out) accounting.
 * Each lot tracks a specific purchase at a specific price and time.
 * Used for accurate P&L calculation and tax reporting.
 *
 * Algorithm:
 * - Each trade creates a new lot with entry price and quantity
 * - When closing position, oldest lots are used first (FIFO)
 * - Unrealized P&L = (current price - entry price) * quantity
 * - Lots can be partially closed
 * - Lots are immutable - closing creates new instance
 *
 * @example
 * ```typescript
 * const lot = new PositionLot(
 *   'lot-1',
 *   'token-123',
 *   'YES',
 *   Quantity.fromNumber(10),
 *   Price.fromNumber(0.65),
 *   new Date()
 * );
 *
 * // Calculate cost
 * const cost = lot.calculateCost();
 * console.log(cost.amount); // 6.50
 *
 * // Calculate unrealized P&L
 * const pnl = lot.calculateUnrealizedPnL(Price.fromNumber(0.70));
 * console.log(pnl.amount); // 0.50 (profit)
 *
 * // Close partial quantity
 * const closedLot = lot.close(Quantity.fromNumber(5));
 * console.log(closedLot.quantity.value); // 5
 * console.log(closedLot.isClosed()); // true
 * ```
 */
import { Price } from '@polymarket/value-objects';
import { Quantity } from '@polymarket/value-objects';
import { Money } from '@polymarket/value-objects';
import { TradingError } from '@polymarket/errors';

/**
 * Side of the position
 */
export type Side = 'YES' | 'NO';

/**
 * Insufficient quantity error
 *
 * @remarks
 * Thrown when trying to close more quantity than available in lot.
 */
export class InsufficientLotQuantityError extends TradingError {
  constructor(
    public readonly requested: number,
    public readonly available: number
  ) {
    super(
      `Insufficient lot quantity: requested ${requested}, available ${available}`,
      'INSUFFICIENT_LOT_QUANTITY'
    );
  }
}

/**
 * PositionLot entity
 *
 * @remarks
 * Immutable entity representing a single lot in FIFO accounting.
 */
export class PositionLot {
  /**
   * Creates a new PositionLot
   *
   * @param lotId - Unique identifier for this lot
   * @param tokenId - ID of the token/market
   * @param side - YES or NO side
   * @param quantity - Amount of shares in this lot
   * @param entryPrice - Price at which this lot was purchased
   * @param timestamp - When this lot was created
   *
   * @throws {Error} If quantity is not positive
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   * ```
   */
  constructor(
    public readonly lotId: string,
    public readonly tokenId: string,
    public readonly side: Side,
    public readonly quantity: Quantity,
    public readonly entryPrice: Price,
    public readonly timestamp: Date
  ) {
    if (!quantity.isPositive()) {
      throw new Error('Lot quantity must be positive');
    }
  }

  /**
   * Calculates the total cost of this lot
   *
   * @returns Money value representing cost (quantity * entry price)
   *
   * @remarks
   * Cost = quantity * entry price
   * This is the amount paid to acquire this lot.
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   * const cost = lot.calculateCost();
   * console.log(cost.amount); // 6.50
   * ```
   */
  public calculateCost(): Money {
    return Money.fromUSDC(this.quantity.value * this.entryPrice.value);
  }

  /**
   * Calculates unrealized profit/loss at current price
   *
   * @param currentPrice - Current market price
   * @returns Money value representing unrealized P&L
   *
   * @remarks
   * Unrealized P&L = (current price - entry price) * quantity
   * - Positive value = profit
   * - Negative value = loss
   *
   * For NO positions, P&L is inverted:
   * - Entry cost = quantity * (1 - entry price)
   * - Current value = quantity * (1 - current price)
   * - P&L = current value - entry cost
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   *
   * // Price went up - profit
   * const pnl1 = lot.calculateUnrealizedPnL(Price.fromNumber(0.70));
   * console.log(pnl1.amount); // 0.50
   *
   * // Price went down - loss
   * const pnl2 = lot.calculateUnrealizedPnL(Price.fromNumber(0.60));
   * console.log(pnl2.amount); // -0.50
   * ```
   */
  public calculateUnrealizedPnL(currentPrice: Price): Money {
    if (this.side === 'YES') {
      // For YES: P&L = (current - entry) * quantity
      const pnl = (currentPrice.value - this.entryPrice.value) * this.quantity.value;
      return Money.fromUSDC(Math.abs(pnl) < 0.000001 ? 0 : pnl);
    } else {
      // For NO: P&L = (entry - current) * quantity
      // Because NO token value moves inversely to price
      const pnl = (this.entryPrice.value - currentPrice.value) * this.quantity.value;
      return Money.fromUSDC(Math.abs(pnl) < 0.000001 ? 0 : pnl);
    }
  }

  /**
   * Closes part or all of this lot
   *
   * @param closeQuantity - Amount to close from this lot
   * @returns New PositionLot with remaining quantity
   *
   * @throws {InsufficientLotQuantityError} If closing more than available
   *
   * @remarks
   * Creates a new lot with reduced quantity.
   * If closing entire quantity, returns lot with zero quantity.
   * Original lot remains unchanged (immutable).
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   *
   * // Close partial
   * const remaining = lot.close(Quantity.fromNumber(6));
   * console.log(remaining.quantity.value); // 4
   * console.log(remaining.isClosed()); // false
   *
   * // Close remaining
   * const closed = remaining.close(Quantity.fromNumber(4));
   * console.log(closed.quantity.value); // 0
   * console.log(closed.isClosed()); // true
   * ```
   */
  public close(closeQuantity: Quantity): PositionLot {
    if (closeQuantity.isGreaterThan(this.quantity)) {
      throw new InsufficientLotQuantityError(
        closeQuantity.value,
        this.quantity.value
      );
    }

    const remainingQuantity = this.quantity.subtract(closeQuantity);

    return new PositionLot(
      this.lotId,
      this.tokenId,
      this.side,
      remainingQuantity,
      this.entryPrice,
      this.timestamp
    );
  }

  /**
   * Checks if lot is fully closed
   *
   * @returns True if quantity is zero
   *
   * @remarks
   * A closed lot has zero quantity and should be removed from inventory.
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   * console.log(lot.isClosed()); // false
   *
   * const closed = lot.close(Quantity.fromNumber(10));
   * console.log(closed.isClosed()); // true
   * ```
   */
  public isClosed(): boolean {
    return this.quantity.isZero();
  }

  /**
   * Creates a string representation of this lot
   *
   * @returns Formatted string with lot details
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date('2024-01-01')
   * );
   * console.log(lot.toString());
   * // "Lot[lot-1]: 10.00 YES @ $0.6500 (2024-01-01)"
   * ```
   */
  public toString(): string {
    return `Lot[${this.lotId}]: ${this.quantity.toString()} ${this.side} @ $${this.entryPrice.toString()} (${this.timestamp.toISOString().split('T')[0]})`;
  }
}
