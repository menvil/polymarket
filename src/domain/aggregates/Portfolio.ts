/**
 * Portfolio aggregate root
 *
 * @remarks
 * Manages all positions and cash balance for a trading account.
 * Aggregate root that ensures consistency of portfolio state.
 *
 * Algorithm:
 * - Tracks total cash and reserved cash (locked in open orders)
 * - Manages positions map: tokenId -> Position
 * - Calculates aggregated metrics: total value, P&L, net/gross positions
 * - Enforces business rules: cash >= 0, reserved <= total, etc.
 * - Immutable - all operations return new Portfolio instances
 *
 * Why an aggregate?
 * - Portfolio is the consistency boundary for positions and cash
 * - All position changes must be coordinated with cash changes
 * - Ensures invariants: can't spend more than available cash
 * - Single source of truth for account state
 *
 * Cash management:
 * - Total cash = available + reserved
 * - Reserved cash = sum of all open BUY order values
 * - Available cash = cash that can be used for new orders
 * - When order is placed: reserve cash
 * - When order is canceled: release cash
 * - When order is filled: convert reserved cash to position
 *
 * Position tracking:
 * - Each market token has one Position (YES or NO)
 * - Positions track lots for FIFO accounting
 * - Adding position: append lot, recalculate averages
 * - Removing position: FIFO close lots
 *
 * @example
 * ```typescript
 * // Create portfolio with initial cash
 * const portfolio = Portfolio.create(Money.fromUSDC(1000));
 * console.log(portfolio.getAvailableCash().amount); // 1000
 *
 * // Reserve cash for order
 * const reserved = portfolio.reserveCash(Money.fromUSDC(100));
 * console.log(reserved.getAvailableCash().amount); // 900
 *
 * // Add position when order fills
 * const lot = new PositionLot(
 *   'lot-1',
 *   'token-123',
 *   'YES',
 *   Quantity.fromNumber(100),
 *   Price.fromNumber(1.00),
 *   new Date()
 * );
 * const withPosition = reserved.addPosition('token-123', 'YES', lot);
 *
 * // Calculate portfolio value
 * const prices = new Map([['token-123', Price.fromNumber(1.05)]]);
 * const value = withPosition.calculateTotalValue(prices);
 * console.log(value.amount); // 1005 (900 cash + 105 position value)
 * ```
 */
import {Money} from '../value-objects/Money.js';
import {Quantity} from '../value-objects/Quantity.js';
import {Price} from '../value-objects/Price.js';
import {Position} from '../entities/Position.js';
import {PositionLot, Side} from '../entities/PositionLot.js';
import {InsufficientFundsError, TradingError} from '../../shared/errors/TradingError.js';

/**
 * Portfolio invariant violation error
 *
 * @remarks
 * Thrown when portfolio state violates business rules.
 */
export class PortfolioInvariantViolationError extends TradingError {
    constructor(message: string) {
        super(`Portfolio invariant violation: ${message}`, 'PORTFOLIO_INVARIANT_VIOLATION');
    }
}

/**
 * Position not found error
 *
 * @remarks
 * Thrown when trying to access non-existent position.
 */
export class PositionNotFoundError extends TradingError {
    constructor(public readonly tokenId: string) {
        super(`Position not found: ${tokenId}`, 'POSITION_NOT_FOUND');
    }
}

/**
 * Portfolio aggregate root
 *
 * @remarks
 * Immutable aggregate managing all positions and cash.
 * All methods return new Portfolio instances.
 */
export class Portfolio {
    /**
     * Creates a new Portfolio
     *
     * @param cash - Total cash balance (available + reserved)
     * @param reservedCash - Cash locked in open BUY orders
     * @param positions - Map of tokenId to Position
     *
     * @remarks
     * Private constructor - use static factory methods instead.
     */
    private constructor(
        public readonly cash: Money,
        public readonly reservedCash: Money,
        public readonly positions: ReadonlyMap<string, Position>
    ) {
    }

    /**
     * Creates a new portfolio with initial cash
     *
     * @param initialCash - Starting cash balance
     * @returns New Portfolio with no positions
     *
     * @throws {Error} If initial cash is negative
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000));
     * console.log(portfolio.cash.amount); // 1000
     * console.log(portfolio.isEmpty()); // true
     * ```
     */
    public static create(initialCash: Money): Portfolio {
        if (initialCash.amount < 0) {
            throw new Error('Initial cash cannot be negative');
        }

        const portfolio = new Portfolio(
            initialCash,
            Money.zero(),
            new Map()
        );

        portfolio.validateInvariants();
        return portfolio;
    }

    /**
     * Adds or updates a position with a new lot
     *
     * @param tokenId - ID of the token/market
     * @param side - YES or NO side
     * @param lot - Position lot to add
     * @returns New Portfolio with added/updated position
     *
     * @throws {Error} If lot token/side doesn't match
     *
     * @remarks
     * Algorithm:
     * 1. Get existing position or create empty one
     * 2. Add lot to position (creates new Position)
     * 3. Update positions map with new Position
     * 4. Validate invariants
     * 5. Return new Portfolio instance
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000));
     *
     * const lot = new PositionLot(
     *   'lot-1',
     *   'token-123',
     *   'YES',
     *   Quantity.fromNumber(100),
     *   Price.fromNumber(0.60),
     *   new Date()
     * );
     *
     * const updated = portfolio.addPosition('token-123', 'YES', lot);
     * const position = updated.getPosition('token-123');
     * console.log(position?.totalQuantity.value); // 100
     * ```
     */
    public addPosition(tokenId: string, side: Side, lot: PositionLot): Portfolio {
        if (lot.tokenId !== tokenId) {
            throw new Error(`Lot tokenId ${lot.tokenId} doesn't match ${tokenId}`);
        }
        if (lot.side !== side) {
            throw new Error(`Lot side ${lot.side} doesn't match ${side}`);
        }

        // Get existing position or create empty one
        const existingPosition = this.positions.get(tokenId) || Position.empty(tokenId, side);

        // Add lot to position
        const updatedPosition = existingPosition.addLot(lot);

        // Update positions map
        const newPositions = new Map(this.positions);
        newPositions.set(tokenId, updatedPosition);

        const portfolio = new Portfolio(
            this.cash,
            this.reservedCash,
            newPositions
        );

        portfolio.validateInvariants();
        return portfolio;
    }

    /**
     * Removes quantity from a position using FIFO
     *
     * @param tokenId - ID of the token/market
     * @param quantity - Amount to remove
     * @returns New Portfolio with reduced position
     *
     * @throws {PositionNotFoundError} If position doesn't exist
     * @throws {Error} If removing more than available
     *
     * @remarks
     * Algorithm:
     * 1. Get position (throw if not found)
     * 2. Remove quantity using FIFO from oldest lot
     * 3. If position becomes empty, remove from map
     * 4. Otherwise, update map with reduced position
     * 5. Validate invariants
     * 6. Return new Portfolio
     *
     * FIFO removal:
     * - Removes from oldest lot first
     * - If lot is fully closed, it's removed
     * - Continues to next lot if needed
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000))
     *   .addPosition('token-123', 'YES', lot1)
     *   .addPosition('token-123', 'YES', lot2);
     *
     * // Remove some quantity (FIFO)
     * const reduced = portfolio.removePosition('token-123', Quantity.fromNumber(50));
     * const position = reduced.getPosition('token-123');
     * console.log(position?.totalQuantity.value); // original - 50
     * ```
     */
    public removePosition(tokenId: string, quantity: Quantity): Portfolio {
        const position = this.positions.get(tokenId);
        if (!position) {
            throw new PositionNotFoundError(tokenId);
        }

        // Remove quantity using FIFO (remove from oldest lot)
        let updatedPosition = position;
        let remainingToRemove = quantity;

        while (remainingToRemove.isPositive() && !updatedPosition.isEmpty()) {
            const oldestLot = updatedPosition.getOldestLot();
            if (!oldestLot) break;

            const toRemove = remainingToRemove.isGreaterThan(oldestLot.quantity)
                ? oldestLot.quantity
                : remainingToRemove;

            updatedPosition = updatedPosition.removeLot(oldestLot.lotId, toRemove);
            remainingToRemove = remainingToRemove.subtract(toRemove);
        }

        // Update positions map
        const newPositions = new Map(this.positions);
        if (updatedPosition.isEmpty()) {
            newPositions.delete(tokenId);
        } else {
            newPositions.set(tokenId, updatedPosition);
        }

        const portfolio = new Portfolio(
            this.cash,
            this.reservedCash,
            newPositions
        );

        portfolio.validateInvariants();
        return portfolio;
    }

    /**
     * Gets a position by token ID
     *
     * @param tokenId - ID of the token/market
     * @returns Position or undefined if not found
     *
     * @example
     * ```typescript
     * const position = portfolio.getPosition('token-123');
     * if (position) {
     *   console.log(position.totalQuantity.value);
     * }
     * ```
     */
    public getPosition(tokenId: string): Position | undefined {
        return this.positions.get(tokenId);
    }

    /**
     * Reserves cash for an open order
     *
     * @param amount - Amount to reserve
     * @returns New Portfolio with reserved cash
     *
     * @throws {InsufficientFundsError} If not enough available cash
     *
     * @remarks
     * When placing a BUY order:
     * 1. Calculate order cost (price * size)
     * 2. Check if enough available cash
     * 3. Move cash from available to reserved
     * 4. Order holds reserved cash until filled or canceled
     *
     * Reserved cash is not available for new orders.
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000));
     *
     * // Reserve cash for order
     * const reserved = portfolio.reserveCash(Money.fromUSDC(100));
     * console.log(reserved.reservedCash.amount); // 100
     * console.log(reserved.getAvailableCash().amount); // 900
     * ```
     */
    public reserveCash(amount: Money): Portfolio {
        const availableCash = this.getAvailableCash();

        if (availableCash.isLessThan(amount)) {
            throw new InsufficientFundsError(amount.amount, availableCash.amount);
        }

        const newReservedCash = this.reservedCash.add(amount);

        const portfolio = new Portfolio(
            this.cash,
            newReservedCash,
            this.positions
        );

        portfolio.validateInvariants();
        return portfolio;
    }

    /**
     * Releases reserved cash from a canceled order
     *
     * @param amount - Amount to release
     * @returns New Portfolio with released cash
     *
     * @throws {Error} If releasing more than reserved
     *
     * @remarks
     * When order is canceled:
     * 1. Move cash from reserved back to available
     * 2. Cash becomes available for new orders
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000))
     *   .reserveCash(Money.fromUSDC(100));
     *
     * // Cancel order - release reserved cash
     * const released = portfolio.releaseCash(Money.fromUSDC(100));
     * console.log(released.reservedCash.amount); // 0
     * console.log(released.getAvailableCash().amount); // 1000
     * ```
     */
    public releaseCash(amount: Money): Portfolio {
        if (this.reservedCash.isLessThan(amount)) {
            throw new Error(
                `Cannot release $${amount.amount}: only $${this.reservedCash.amount} reserved`
            );
        }

        const newReservedCash = this.reservedCash.subtract(amount);

        const portfolio = new Portfolio(
            this.cash,
            newReservedCash,
            this.positions
        );

        portfolio.validateInvariants();
        return portfolio;
    }

    /**
     * Deducts cash from total balance
     *
     * @param amount - Amount to deduct
     * @returns New Portfolio with reduced cash
     *
     * @throws {InsufficientFundsError} If deducting more than available
     *
     * @remarks
     * When order fills (BUY side):
     * 1. Deduct fill cost from total cash
     * 2. Cash is converted to position value
     *
     * This is different from reserveCash:
     * - reserveCash: moves cash to reserved (still part of total)
     * - deductCash: removes cash from total (spent on position)
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000));
     *
     * // Deduct cash for filled order
     * const afterPurchase = portfolio.deductCash(Money.fromUSDC(60));
     * console.log(afterPurchase.cash.amount); // 940
     * ```
     */
    public deductCash(amount: Money): Portfolio {
        const newCash = this.cash.subtract(amount);

        if (newCash.amount < 0) {
            throw new InsufficientFundsError(amount.amount, this.cash.amount);
        }

        const portfolio = new Portfolio(
            newCash,
            this.reservedCash,
            this.positions
        );

        portfolio.validateInvariants();
        return portfolio;
    }

    /**
     * Adds cash to total balance
     *
     * @param amount - Amount to add
     * @returns New Portfolio with increased cash
     *
     * @remarks
     * When order fills (SELL side):
     * 1. Add fill proceeds to total cash
     * 2. Position value converted to cash
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000));
     *
     * // Add cash from sold position
     * const afterSale = portfolio.addCash(Money.fromUSDC(70));
     * console.log(afterSale.cash.amount); // 1070
     * ```
     */
    public addCash(amount: Money): Portfolio {
        const newCash = this.cash.add(amount);

        const portfolio = new Portfolio(
            newCash,
            this.reservedCash,
            this.positions
        );

        portfolio.validateInvariants();
        return portfolio;
    }

    /**
     * Calculates total portfolio value (cash + positions)
     *
     * @param prices - Map of tokenId to current market price
     * @returns Total portfolio value
     *
     * @remarks
     * Total value = available cash + sum of all position values
     * Position value = quantity * current price
     *
     * Note: Reserved cash is still part of total value
     * (it will become position value when order fills)
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000))
     *   .addPosition('token-123', 'YES', lot); // 100 shares @ 0.60
     *
     * const prices = new Map([
     *   ['token-123', Price.fromNumber(0.70)] // Price went up
     * ]);
     *
     * const value = portfolio.calculateTotalValue(prices);
     * // value = 1000 (cash) + 70 (100 * 0.70) = 1070
     * console.log(value.amount); // 1070
     * ```
     */
    public calculateTotalValue(prices: Map<string, Price>): Money {
        let totalValue = this.cash.amount;

        for (const [tokenId, position] of this.positions) {
            const currentPrice = prices.get(tokenId);
            if (currentPrice) {
                const positionValue = position.totalQuantity.value * currentPrice.value;
                totalValue += positionValue;
            } else {
                // If no price available, use entry price (conservative)
                const positionValue = position.totalQuantity.value * position.averageEntryPrice.value;
                totalValue += positionValue;
            }
        }

        return Money.fromUSDC(totalValue);
    }

    /**
     * Calculates total unrealized profit/loss across all positions
     *
     * @param prices - Map of tokenId to current market price
     * @returns Total unrealized P&L
     *
     * @remarks
     * Unrealized P&L = sum of P&L from all positions
     * Each position P&L = (current price - avg entry price) * quantity
     *
     * Positive = profit, Negative = loss
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000))
     *   .addPosition('token-123', 'YES', lot1) // 100 @ 0.60
     *   .addPosition('token-456', 'NO', lot2); // 50 @ 0.40
     *
     * const prices = new Map([
     *   ['token-123', Price.fromNumber(0.70)], // +10 profit
     *   ['token-456', Price.fromNumber(0.35)]  // +2.5 profit (NO inverted)
     * ]);
     *
     * const pnl = portfolio.calculateUnrealizedPnL(prices);
     * console.log(pnl.amount); // 12.5
     * ```
     */
    public calculateUnrealizedPnL(prices: Map<string, Price>): Money {
        let totalPnL = 0;

        for (const [tokenId, position] of this.positions) {
            const currentPrice = prices.get(tokenId);
            if (currentPrice) {
                const positionPnL = position.calculateUnrealizedPnL(currentPrice);
                totalPnL += positionPnL.amount;
            }
        }

        return Money.fromUSDC(totalPnL);
    }

    /**
     * Calculates total cost basis of all positions
     *
     * @returns Sum of all position costs
     *
     * @remarks
     * Total cost = sum of (quantity * entry price) for all positions
     * This is how much was paid to acquire all positions.
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000))
     *   .addPosition('token-123', 'YES', lot1) // 100 @ 0.60 = 60
     *   .addPosition('token-456', 'NO', lot2);  // 50 @ 0.40 = 20
     *
     * const cost = portfolio.calculateTotalCost();
     * console.log(cost.amount); // 80
     * ```
     */
    public calculateTotalCost(): Money {
        let totalCost = 0;

        for (const position of this.positions.values()) {
            totalCost += position.getTotalCost().amount;
        }

        return Money.fromUSDC(totalCost);
    }

    /**
     * Gets available cash (not reserved)
     *
     * @returns Available cash for new orders
     *
     * @remarks
     * Available cash = total cash - reserved cash
     * This is the maximum amount that can be used for new orders.
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000))
     *   .reserveCash(Money.fromUSDC(100));
     *
     * console.log(portfolio.getAvailableCash().amount); // 900
     * ```
     */
    public getAvailableCash(): Money {
        return this.cash.subtract(this.reservedCash);
    }

    /**
     * Checks if portfolio can afford an order
     *
     * @param price - Order price
     * @param size - Order size
     * @returns True if enough available cash
     *
     * @remarks
     * Order cost = price * size
     * Can afford if: available cash >= order cost
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000));
     *
     * const canAfford = portfolio.canAffordOrder(
     *   Price.fromNumber(0.60),
     *   Quantity.fromNumber(1000)
     * );
     * console.log(canAfford); // false (need 600, have 1000 but not enough)
     *
     * const canAfford2 = portfolio.canAffordOrder(
     *   Price.fromNumber(0.50),
     *   Quantity.fromNumber(100)
     * );
     * console.log(canAfford2); // true (need 50, have 1000)
     * ```
     */
    public canAffordOrder(price: Price, size: Quantity): boolean {
        const orderCost = Money.fromUSDC(price.value * size.value);
        const availableCash = this.getAvailableCash();
        return availableCash.isGreaterThan(orderCost) || availableCash.equals(orderCost);
    }

    /**
     * Checks if portfolio is empty
     *
     * @returns True if no positions and no reserved cash
     *
     * @remarks
     * Empty portfolio has:
     * - No positions (empty map)
     * - No reserved cash
     *
     * May still have available cash.
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000));
     * console.log(portfolio.isEmpty()); // true (no positions)
     *
     * const withPosition = portfolio.addPosition('token-123', 'YES', lot);
     * console.log(withPosition.isEmpty()); // false (has position)
     * ```
     */
    public isEmpty(): boolean {
        return this.positions.size === 0 && this.reservedCash.isZero();
    }

    /**
     * Gets total YES shares across all positions
     *
     * @returns Total quantity of YES shares
     *
     * @remarks
     * Sums quantity from all YES positions.
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000))
     *   .addPosition('token-123', 'YES', lot1) // 100 YES
     *   .addPosition('token-456', 'YES', lot2) // 50 YES
     *   .addPosition('token-789', 'NO', lot3);  // 30 NO
     *
     * console.log(portfolio.yesShares.value); // 150
     * ```
     */
    public get yesShares(): Quantity {
        let total = 0;
        for (const position of this.positions.values()) {
            if (position.side === 'YES') {
                total += position.totalQuantity.value;
            }
        }
        return Quantity.fromNumber(total);
    }

    /**
     * Gets total NO shares across all positions
     *
     * @returns Total quantity of NO shares
     *
     * @remarks
     * Sums quantity from all NO positions.
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000))
     *   .addPosition('token-123', 'YES', lot1) // 100 YES
     *   .addPosition('token-456', 'NO', lot2)  // 50 NO
     *   .addPosition('token-789', 'NO', lot3);  // 30 NO
     *
     * console.log(portfolio.noShares.value); // 80
     * ```
     */
    public get noShares(): Quantity {
        let total = 0;
        for (const position of this.positions.values()) {
            if (position.side === 'NO') {
                total += position.totalQuantity.value;
            }
        }
        return Quantity.fromNumber(total);
    }

    /**
     * Gets net position (YES - NO)
     *
     * @returns Net position value
     *
     * @remarks
     * Net position = total YES shares - total NO shares
     * - Positive = net long (more YES)
     * - Negative = net short (more NO)
     * - Zero = neutral
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000))
     *   .addPosition('token-123', 'YES', lot1) // 100 YES
     *   .addPosition('token-456', 'NO', lot2);  // 30 NO
     *
     * console.log(portfolio.netPosition); // 70 (100 - 30)
     * ```
     */
    public get netPosition(): number {
        return this.yesShares.value - this.noShares.value;
    }

    /**
     * Gets gross position (YES + NO)
     *
     * @returns Gross position value
     *
     * @remarks
     * Gross position = total YES shares + total NO shares
     * Measures total exposure regardless of direction.
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000))
     *   .addPosition('token-123', 'YES', lot1) // 100 YES
     *   .addPosition('token-456', 'NO', lot2);  // 30 NO
     *
     * console.log(portfolio.grossPosition); // 130 (100 + 30)
     * ```
     */
    public get grossPosition(): number {
        return this.yesShares.value + this.noShares.value;
    }

    /**
     * Validates business rules and invariants
     *
     * @throws {PortfolioInvariantViolationError} If any invariant is violated
     *
     * @remarks
     * Business rules:
     * 1. Cash must be non-negative
     * 2. Reserved cash must be non-negative
     * 3. Reserved cash cannot exceed total cash
     * 4. All positions must be valid (positive quantity)
     *
     * Called automatically after every state change.
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000));
     * portfolio.validateInvariants(); // OK
     *
     * // Trying to create invalid state throws error
     * try {
     *   portfolio.reserveCash(Money.fromUSDC(2000));
     * } catch (e) {
     *   console.log(e.message); // "Insufficient funds"
     * }
     * ```
     */
    public validateInvariants(): void {
        // Rule 1: Cash must be non-negative
        if (this.cash.amount < 0) {
            throw new PortfolioInvariantViolationError(
                `Cash cannot be negative: ${this.cash.amount}`
            );
        }

        // Rule 2: Reserved cash must be non-negative
        if (this.reservedCash.amount < 0) {
            throw new PortfolioInvariantViolationError(
                `Reserved cash cannot be negative: ${this.reservedCash.amount}`
            );
        }

        // Rule 3: Reserved cash cannot exceed total cash
        if (this.reservedCash.isGreaterThan(this.cash)) {
            throw new PortfolioInvariantViolationError(
                `Reserved cash ($${this.reservedCash.amount}) exceeds total cash ($${this.cash.amount})`
            );
        }

        // Rule 4: All positions must be valid
        for (const [tokenId, position] of this.positions) {
            if (position.totalQuantity.value < 0) {
                throw new PortfolioInvariantViolationError(
                    `Position ${tokenId} has negative quantity: ${position.totalQuantity.value}`
                );
            }

            // Positions should not be empty (should be removed from map)
            if (position.isEmpty()) {
                throw new PortfolioInvariantViolationError(
                    `Position ${tokenId} is empty but not removed from map`
                );
            }
        }
    }

    /**
     * Creates a string representation of portfolio
     *
     * @returns Formatted string with portfolio summary
     *
     * @example
     * ```typescript
     * const portfolio = Portfolio.create(Money.fromUSDC(1000))
     *   .addPosition('token-123', 'YES', lot);
     *
     * console.log(portfolio.toString());
     * // "Portfolio: $1000.00 cash ($900.00 available, $100.00 reserved), 1 positions, net: +100, gross: 100"
     * ```
     */
    public toString(): string {
        return `Portfolio: ${this.cash.toString()} cash (${this.getAvailableCash().toString()} available, ${this.reservedCash.toString()} reserved), ${this.positions.size} positions, net: ${this.netPosition > 0 ? '+' : ''}${this.netPosition}, gross: ${this.grossPosition}`;
    }
}
