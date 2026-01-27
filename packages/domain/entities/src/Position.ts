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
 * Design Patterns:
 * - Result pattern для всех fallible операций (addLot, removeLot)
 * - Private constructor + static factory method (empty)
 * - Immutability: все операции возвращают новый Position
 *
 * @example
 * ```typescript
 * const position = Position.empty('token-123', 'YES');
 *
 * // Add first lot (возвращает Result)
 * const lot1Result = PositionLot.create(
 *   'lot-1',
 *   'token-123',
 *   'YES',
 *   Quantity.fromValue(10).value,
 *   Price.fromValue(0.60).value,
 *   Date.now()
 * );
 * if (!lot1Result.ok) {
 *   console.error('Failed to create lot:', lot1Result.error.message);
 *   return;
 * }
 *
 * const addResult1 = position.addLot(lot1Result.value);
 * if (!addResult1.ok) {
 *   console.error('Failed to add lot:', addResult1.error.message);
 *   return;
 * }
 *
 * console.log(addResult1.value.totalQuantity.value); // 10
 * console.log(addResult1.value.averageEntryPrice.value); // 0.60
 *
 * // Add second lot
 * const lot2Result = PositionLot.create(
 *   'lot-2',
 *   'token-123',
 *   'YES',
 *   Quantity.fromValue(5).value,
 *   Price.fromValue(0.70).value,
 *   Date.now()
 * );
 * if (!lot2Result.ok) return;
 *
 * const addResult2 = addResult1.value.addLot(lot2Result.value);
 * if (!addResult2.ok) return;
 *
 * console.log(addResult2.value.totalQuantity.value); // 15
 * console.log(addResult2.value.averageEntryPrice.value); // 0.6333 (weighted average)
 *
 * // Remove quantity (FIFO, возвращает Result)
 * const removeResult = addResult2.value.removeLot('lot-1', Quantity.fromValue(8).value);
 * if (!removeResult.ok) {
 *   console.error('Failed to remove lot:', removeResult.error.message);
 *   return;
 * }
 * // lot-1 now has 2 remaining, lot-2 is untouched
 * ```
 */
import { Price } from '@polymarket/value-objects';
import { Quantity } from '@polymarket/value-objects';
import { Money } from '@polymarket/value-objects';
import { PositionLot, Side, InsufficientLotQuantityError } from './PositionLot.js';
import { TradingError, PositionValidationError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

/**
 * Insufficient position error
 *
 * @remarks
 * Thrown when trying to remove more quantity than available in position.
 */
export class InsufficientPositionError extends TradingError {
  public readonly severity = 'low' as const;

  constructor(
    public readonly requested: number,
    public readonly available: number
  ) {
    super(
      `Insufficient position: requested ${requested}, available ${available}`,
      { code: 'INSUFFICIENT_POSITION', context: { requested, available } }
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
  public readonly severity = 'low' as const;

  constructor(public readonly lotId: string) {
    super(`Lot not found: ${lotId}`, { code: 'LOT_NOT_FOUND', context: { lotId } });
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
   * @remarks
   * Использует neutral price (0.50) для пустой позиции.
   * Price.fromValue(0.50) гарантированно успешен (математическая инвариантность).
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   * console.log(position.isEmpty()); // true
   * console.log(position.totalQuantity.value); // 0
   * ```
   */
  public static empty(tokenId: string, side: Side): Position {
    // Price.fromValue(0.50) гарантированно успешен
    const neutralPriceResult = Price.fromValue(0.50);
    if (!neutralPriceResult.ok) {
      // Это не должно случиться никогда, но для type safety
      throw new Error('Failed to create neutral price for empty position');
    }

    return new Position(
      tokenId,
      side,
      Quantity.zero(),
      neutralPriceResult.value,
      [],
      Money.zero()
    );
  }

  /**
   * Добавляет новый лот к позиции
   *
   * @param lot - Лот для добавления
   * @returns Result с новой Position или ошибкой
   *
   * @remarks
   * Шаги:
   * 1. Валидирует совпадение tokenId и side
   * 2. Добавляет лот в массив
   * 3. Пересчитывает total quantity и average entry price
   * 4. Возвращает новый immutable Position
   *
   * Алгоритм вычисления средней цены:
   * - new_avg = (old_cost + new_cost) / (old_qty + new_qty)
   * - где cost = quantity * price
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   *
   * const lotResult = PositionLot.create(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromValue(10).value,
   *   Price.fromValue(0.60).value,
   *   Date.now()
   * );
   *
   * if (lotResult.ok) {
   *   const result = position.addLot(lotResult.value);
   *   if (result.ok) {
   *     console.log(result.value.totalQuantity.value); // 10
   *     console.log(result.value.averageEntryPrice.value); // 0.60
   *   }
   * }
   * ```
   */
  public addLot(lot: PositionLot): Result<Position, PositionValidationError> {
    // Валидация tokenId
    if (lot.tokenId !== this.tokenId) {
      return Err(
        new PositionValidationError(
          `Token mismatch: lot ${lot.tokenId} vs position ${this.tokenId}`,
          {
            context: {
              lotTokenId: lot.tokenId,
              positionTokenId: this.tokenId,
              lotId: lot.lotId
            }
          }
        )
      );
    }

    // Валидация side
    if (lot.side !== this.side) {
      return Err(
        new PositionValidationError(
          `Side mismatch: lot ${lot.side} vs position ${this.side}`,
          {
            context: {
              lotSide: lot.side,
              positionSide: this.side,
              lotId: lot.lotId
            }
          }
        )
      );
    }

    const newLots = [...this.lots, lot];

    // Add quantities
    const addResult = this.totalQuantity.add(lot.quantity);
    if (!addResult.ok) {
      return Err(
        new PositionValidationError(
          `Failed to add quantities: ${addResult.error.message}`,
          { context: { lotId: lot.lotId, currentQuantity: this.totalQuantity.value, addQuantity: lot.quantity.value } }
        )
      );
    }
    const newTotalQuantity = addResult.value;

    // Calculate weighted average entry price
    const oldCost = this.totalQuantity.value * this.averageEntryPrice.value;
    const newCost = lot.quantity.value * lot.entryPrice.value;
    const totalCost = oldCost + newCost;

    // Математически гарантировано валидно если оба price валидны
    const avgPriceValue = newTotalQuantity.value > 0
      ? totalCost / newTotalQuantity.value
      : 0.5;

    // Используем fromValue() для консистентности
    const newAveragePriceResult = Price.fromValue(avgPriceValue);
    if (!newAveragePriceResult.ok) {
      return Err(
        new PositionValidationError(
          `Failed to calculate average price: ${newAveragePriceResult.error.message}`,
          { context: { avgPriceValue, totalCost, totalQuantity: newTotalQuantity.value } }
        )
      );
    }

    return Ok(
      new Position(
        this.tokenId,
        this.side,
        newTotalQuantity,
        newAveragePriceResult.value,
        newLots,
        Money.zero()
      )
    );
  }

  /**
   * Удаляет количество из позиции используя FIFO
   *
   * @param lotId - ID лота
   * @param quantity - Количество для удаления
   * @returns Result с новой Position или ошибкой
   *
   * @remarks
   * FIFO Алгоритм:
   * 1. Находим указанный лот в массиве
   * 2. Закрываем указанное количество из этого лота (через lot.close())
   * 3. Если лот полностью закрыт (quantity = 0) - удаляем его из массива
   * 4. Пересчитываем total quantity (сумма оставшихся лотов)
   * 5. Пересчитываем average entry price (weighted average оставшихся)
   * 6. Возвращаем новый immutable Position
   *
   * Почему FIFO?
   * - Налоговое соответствие: большинство юрисдикций требуют FIFO
   * - Простота: не нужно отслеживать какие конкретно акции проданы
   * - Справедливость: самые старые покупки закрываются первыми
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   * const result1 = position.addLot(lot1); // 10 shares @ 0.60
   * if (!result1.ok) return;
   * const result2 = result1.value.addLot(lot2); // 5 shares @ 0.70
   * if (!result2.ok) return;
   *
   * // Remove 8 shares (FIFO: takes from lot1 first)
   * const removeResult = result2.value.removeLot('lot-1', Quantity.fromValue(8).value);
   * if (removeResult.ok) {
   *   console.log(removeResult.value.totalQuantity.value); // 7
   *   // lot1 has 2 remaining, lot2 still has 5
   * }
   * ```
   */
  public removeLot(
    lotId: string,
    quantity: Quantity
  ): Result<Position, LotNotFoundError | InsufficientLotQuantityError | PositionValidationError> {
    const lotIndex = this.lots.findIndex((l) => l.lotId === lotId);
    if (lotIndex === -1) {
      return Err(new LotNotFoundError(lotId));
    }

    const lot = this.lots[lotIndex];

    // Close specified quantity from this lot (returns Result)
    const closeResult = lot.close(quantity);
    if (!closeResult.ok) {
      return Err(closeResult.error);  // Propagate error
    }

    const updatedLot = closeResult.value;

    // Remove lot if fully closed, otherwise replace it
    const newLots = updatedLot.isClosed()
      ? this.lots.filter((l) => l.lotId !== lotId)
      : this.lots.map((l, i) => (i === lotIndex ? updatedLot : l));

    // Recalculate total quantity using manual loop to handle Results
    let totalQty = Quantity.zero();
    for (const lot of newLots) {
      const addResult = totalQty.add(lot.quantity);
      if (!addResult.ok) {
        return Err(
          new PositionValidationError(
            `Failed to sum quantities: ${addResult.error.message}`,
            { context: { lotId: lot.lotId } }
          )
        );
      }
      totalQty = addResult.value;
    }
    const newTotalQuantity = totalQty;

    let newAveragePrice = this.averageEntryPrice;
    if (newLots.length > 0) {
      const totalCost = newLots.reduce(
        (sum, l) => sum + l.quantity.value * l.entryPrice.value,
        0
      );
      const avgPriceValue = totalCost / newTotalQuantity.value;

      const priceResult = Price.fromValue(avgPriceValue);
      if (!priceResult.ok) {
        return Err(
          new PositionValidationError(
            `Failed to calculate average price: ${priceResult.error.message}`,
            { context: { avgPriceValue, totalCost } }
          )
        );
      }
      newAveragePrice = priceResult.value;
    }

    return Ok(
      new Position(
        this.tokenId,
        this.side,
        newTotalQuantity,
        newAveragePrice,
        newLots,
        Money.zero()
      )
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
      return sum + lotPnL.getAmount();
    }, 0);

    const result = Money.fromValue(totalPnL);
    if (!result.ok) {
      // Это не должно случиться - математически гарантировано валидно
      throw new Error(`Failed to create Money for total P&L: ${result.error.message}`);
    }

    return result.value;
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
      return sum + lot.calculateCost().getAmount();
    }, 0);

    const result = Money.fromValue(totalCost);
    if (!result.ok) {
      // Это не должно случиться - математически гарантировано валидно
      throw new Error(`Failed to create Money for total cost: ${result.error.message}`);
    }

    return result.value;
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
