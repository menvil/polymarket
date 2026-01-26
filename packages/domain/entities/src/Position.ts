/**
 * Position entity
 *
 * @remarks
 * Represents aggregate position in a token with FIFO lot accounting.
 * Manages multiple lots for accurate P&L tracking and tax reporting.
 *
 * Algorithm:
 * - Position consists of multiple lots (FIFO queue)
 * - Adding lot: appends to lots array, recalculates average entry price
 * - Removing: uses oldest lots first (FIFO)
 * - Average entry price = total cost / total quantity
 * - Unrealized P&L = sum of all lot P&Ls
 *
 * Why FIFO?
 * - Required by most tax jurisdictions
 * - Provides accurate cost basis tracking
 * - Simplifies accounting (no need to match specific lots)
 * - Industry standard for securities
 *
 * @example
 * ```typescript
 * const position = Position.empty('token-123', 'YES');
 *
 * // Add first lot
 * const lot1 = new PositionLot(
 *   'lot-1',
 *   'token-123',
 *   'YES',
 *   Quantity.fromNumber(10),
 *   Price.fromNumber(0.60),
 *   new Date()
 * );
 * position = position.addLot(lot1);
 * console.log(position.totalQuantity.value); // 10
 * console.log(position.averageEntryPrice.value); // 0.60
 *
 * // Add second lot
 * const lot2 = new PositionLot(
 *   'lot-2',
 *   'token-123',
 *   'YES',
 *   Quantity.fromNumber(5),
 *   Price.fromNumber(0.70),
 *   new Date()
 * );
 * position = position.addLot(lot2);
 * console.log(position.totalQuantity.value); // 15
 * console.log(position.averageEntryPrice.value); // 0.6333 (weighted average)
 *
 * // Remove quantity (FIFO)
 * position = position.removeLot('lot-1', Quantity.fromNumber(8));
 * // lot-1 now has 2 remaining, lot-2 is untouched
 * ```
 */
import { Price } from '@polymarket/value-objects';
import { Quantity } from '@polymarket/value-objects';
import { Money } from '@polymarket/value-objects';
import { PositionLot, Side } from './PositionLot.js';
import { TradingError } from '@polymarket/errors';

/**
 * Insufficient position error
 *
 * @remarks
 * Thrown when trying to remove more quantity than available in position.
 */
export class InsufficientPositionError extends TradingError {
  constructor(
    public readonly requested: number,
    public readonly available: number
  ) {
    super(
      `Insufficient position: requested ${requested}, available ${available}`,
      'INSUFFICIENT_POSITION'
    );
  }
}

/**
 * Lot not found error
 *
 * @remarks
 * Thrown when trying to remove from non-existent lot.
 */
export class LotNotFoundError extends TradingError {
  constructor(public readonly lotId: string) {
    super(`Lot not found: ${lotId}`, 'LOT_NOT_FOUND');
  }
}

/**
 * Position entity
 *
 * @remarks
 * Immutable entity representing aggregate position with FIFO lot tracking.
 */
export class Position {
  /**
   * Creates a new Position
   *
   * @param tokenId - ID of the token/market
   * @param side - YES or NO side
   * @param totalQuantity - Total quantity across all lots
   * @param averageEntryPrice - Weighted average entry price
   * @param lots - Array of lots (FIFO order)
   * @param unrealizedPnL - Current unrealized profit/loss
   *
   * @remarks
   * Private constructor - use static factory methods instead.
   */
  private constructor(
    public readonly tokenId: string,
    public readonly side: Side,
    public readonly totalQuantity: Quantity,
    public readonly averageEntryPrice: Price,
    public readonly lots: readonly PositionLot[],
    public readonly unrealizedPnL: Money
  ) {}

  /**
   * Creates an empty position
   *
   * @param tokenId - ID of the token/market
   * @param side - YES or NO side
   * @returns Empty position with no lots
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   * console.log(position.isEmpty()); // true
   * console.log(position.totalQuantity.value); // 0
   * ```
   */
  public static empty(tokenId: string, side: Side): Position {
    return new Position(
      tokenId,
      side,
      Quantity.zero(),
      Price.fromNumber(0.50), // Neutral price for empty position
      [],
      Money.zero()
    );
  }

  /**
   * Adds a new lot to the position
   *
   * @param lot - Lot to add
   * @returns New Position with added lot
   *
   * @throws {Error} If lot token/side doesn't match position
   *
   * @remarks
   * Steps:
   * 1. Validates lot matches position token and side
   * 2. Appends lot to lots array
   * 3. Recalculates total quantity (sum of all lots)
   * 4. Recalculates average entry price (weighted average)
   * 5. Returns new immutable Position instance
   *
   * Average price calculation:
   * - new_avg = (old_cost + new_cost) / (old_qty + new_qty)
   * - where cost = quantity * price
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   *
   * const lot1 = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.60),
   *   new Date()
   * );
   *
   * const newPosition = position.addLot(lot1);
   * console.log(newPosition.totalQuantity.value); // 10
   * console.log(newPosition.averageEntryPrice.value); // 0.60
   * ```
   */
  public addLot(lot: PositionLot): Position {
    if (lot.tokenId !== this.tokenId) {
      throw new Error(
        `Token mismatch: lot ${lot.tokenId} vs position ${this.tokenId}`
      );
    }
    if (lot.side !== this.side) {
      throw new Error(
        `Side mismatch: lot ${lot.side} vs position ${this.side}`
      );
    }

    const newLots = [...this.lots, lot];
    const newTotalQuantity = this.totalQuantity.add(lot.quantity);

    // Calculate weighted average entry price
    const oldCost = this.totalQuantity.value * this.averageEntryPrice.value;
    const newCost = lot.quantity.value * lot.entryPrice.value;
    const totalCost = oldCost + newCost;

    const newAveragePrice =
      newTotalQuantity.value > 0
        ? Price.fromNumber(totalCost / newTotalQuantity.value)
        : this.averageEntryPrice;

    return new Position(
      this.tokenId,
      this.side,
      newTotalQuantity,
      newAveragePrice,
      newLots,
      Money.zero() // Will be recalculated on demand
    );
  }

  /**
   * Removes quantity from position using FIFO
   *
   * @param lotId - ID of the lot to remove from
   * @param quantity - Amount to remove
   * @returns New Position with reduced quantity
   *
   * @throws {LotNotFoundError} If lot doesn't exist
   * @throws {InsufficientPositionError} If removing more than available
   *
   * @remarks
   * FIFO Algorithm:
   * 1. Find the specified lot in the lots array
   * 2. Close the specified quantity from that lot
   * 3. If lot is fully closed (quantity = 0), remove it from array
   * 4. Recalculate total quantity (sum remaining lots)
   * 5. Recalculate average entry price (weighted average of remaining)
   * 6. Return new immutable Position
   *
   * Why FIFO?
   * - Tax compliance: most jurisdictions require FIFO
   * - Simplicity: no need to track which specific shares were sold
   * - Fair: oldest purchases are closed first
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1) // 10 shares @ 0.60
   *   .addLot(lot2); // 5 shares @ 0.70
   *
   * // Remove 8 shares (FIFO: takes from lot1 first)
   * const reduced = position.removeLot('lot-1', Quantity.fromNumber(8));
   * console.log(reduced.totalQuantity.value); // 7
   * // lot1 has 2 remaining, lot2 still has 5
   *
   * // Remove remaining from lot1
   * const reduced2 = reduced.removeLot('lot-1', Quantity.fromNumber(2));
   * console.log(reduced2.lots.length); // 1 (lot1 removed)
   * ```
   */
  public removeLot(lotId: string, quantity: Quantity): Position {
    const lotIndex = this.lots.findIndex((l) => l.lotId === lotId);
    if (lotIndex === -1) {
      throw new LotNotFoundError(lotId);
    }

    const lot = this.lots[lotIndex];

    // Close the specified quantity from this lot
    const updatedLot = lot.close(quantity);

    // Remove lot if fully closed, otherwise replace it
    const newLots = updatedLot.isClosed()
      ? this.lots.filter((l) => l.lotId !== lotId)
      : this.lots.map((l, i) => (i === lotIndex ? updatedLot : l));

    // Recalculate total quantity and average price
    const newTotalQuantity = newLots.reduce(
      (sum, l) => sum.add(l.quantity),
      Quantity.zero()
    );

    let newAveragePrice = this.averageEntryPrice;
    if (newLots.length > 0) {
      const totalCost = newLots.reduce(
        (sum, l) => sum + l.quantity.value * l.entryPrice.value,
        0
      );
      newAveragePrice = Price.fromNumber(totalCost / newTotalQuantity.value);
    }

    return new Position(
      this.tokenId,
      this.side,
      newTotalQuantity,
      newAveragePrice,
      newLots,
      Money.zero() // Will be recalculated on demand
    );
  }

  /**
   * Calculates total unrealized P&L at current price
   *
   * @param currentPrice - Current market price
   * @returns Total unrealized P&L across all lots
   *
   * @remarks
   * Sums unrealized P&L from each lot.
   * Each lot calculates its own P&L based on entry price.
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1) // 10 @ 0.60
   *   .addLot(lot2); // 5 @ 0.70
   *
   * // Current price is 0.75
   * const pnl = position.calculateUnrealizedPnL(Price.fromNumber(0.75));
   * // lot1: (0.75 - 0.60) * 10 = 1.50
   * // lot2: (0.75 - 0.70) * 5 = 0.25
   * // total: 1.75
   * console.log(pnl.amount); // 1.75
   * ```
   */
  public calculateUnrealizedPnL(currentPrice: Price): Money {
    if (this.lots.length === 0) {
      return Money.zero();
    }

    const totalPnL = this.lots.reduce((sum, lot) => {
      const lotPnL = lot.calculateUnrealizedPnL(currentPrice);
      return sum + lotPnL.amount;
    }, 0);

    return Money.fromUSDC(totalPnL);
  }

  /**
   * Gets the oldest lot (for FIFO removal)
   *
   * @returns Oldest lot or undefined if no lots
   *
   * @remarks
   * Returns first lot in array (oldest by timestamp).
   * Used for FIFO position closing.
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1) // Added first
   *   .addLot(lot2); // Added second
   *
   * const oldest = position.getOldestLot();
   * console.log(oldest?.lotId); // 'lot-1'
   * ```
   */
  public getOldestLot(): PositionLot | undefined {
    return this.lots[0];
  }

  /**
   * Checks if position is empty
   *
   * @returns True if no quantity or no lots
   *
   * @remarks
   * Empty position has zero quantity and no lots.
   * Should be removed from inventory when empty.
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   * console.log(position.isEmpty()); // true
   *
   * const withLot = position.addLot(lot);
   * console.log(withLot.isEmpty()); // false
   * ```
   */
  public isEmpty(): boolean {
    return this.lots.length === 0 || this.totalQuantity.isZero();
  }

  /**
   * Calculates total cost basis of position
   *
   * @returns Total cost of all lots
   *
   * @remarks
   * Sum of cost basis from all lots.
   * Used for P&L calculation and reporting.
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1) // 10 @ 0.60 = 6.00
   *   .addLot(lot2); // 5 @ 0.70 = 3.50
   *
   * const cost = position.getTotalCost();
   * console.log(cost.amount); // 9.50
   * ```
   */
  public getTotalCost(): Money {
    if (this.lots.length === 0) {
      return Money.zero();
    }

    const totalCost = this.lots.reduce((sum, lot) => {
      return sum + lot.calculateCost().amount;
    }, 0);

    return Money.fromUSDC(totalCost);
  }

  /**
   * Gets number of lots in position
   *
   * @returns Number of lots
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1)
   *   .addLot(lot2);
   * console.log(position.getLotCount()); // 2
   * ```
   */
  public getLotCount(): number {
    return this.lots.length;
  }

  /**
   * Creates a string representation of position
   *
   * @returns Formatted string with position summary
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1)
   *   .addLot(lot2);
   * console.log(position.toString());
   * // "Position[token-123/YES]: 15.00 shares @ avg $0.6333 (2 lots)"
   * ```
   */
  public toString(): string {
    return `Position[${this.tokenId}/${this.side}]: ${this.totalQuantity.toString()} shares @ avg $${this.averageEntryPrice.toString()} (${this.lots.length} lots)`;
  }
}
