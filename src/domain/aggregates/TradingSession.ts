/**
 * TradingSession aggregate root
 *
 * @remarks
 * Root aggregate managing the entire trading session state.
 * Coordinates market, portfolio, risk, and orders.
 *
 * Algorithm:
 * - Tracks all active orders with their state
 * - Manages cash reservation for BUY orders
 * - Processes order fills and updates positions
 * - Monitors risk and enforces limits
 * - Validates all business rules and invariants
 * - Immutable - all operations return new instances
 *
 * Why the root aggregate?
 * - Trading session is the top-level consistency boundary
 * - All trading operations flow through the session
 * - Coordinates portfolio, risk, and orders together
 * - Ensures global invariants across all entities
 * - Single source of truth for entire trading state
 *
 * Order lifecycle:
 * 1. placeOrder(): Reserve cash (if BUY), add to active orders
 * 2. Order sits in activeOrders map until filled or canceled
 * 3. fillOrder(): Update position, convert reserved cash, remove from active
 * 4. cancelOrder(): Release reserved cash, remove from active
 *
 * Risk management:
 * - Continuously updates risk based on portfolio state
 * - Enforces position and loss limits
 * - Transitions between trading modes
 * - Can block orders if limits exceeded
 *
 * @example
 * ```typescript
 * // Create session
 * const market = Market.create({...});
 * const session = TradingSession.create(market, Money.fromUSDC(1000));
 * console.log(session.portfolio.cash.amount); // 1000
 *
 * // Place order
 * const order = Order.create({
 *   id: 'order-1',
 *   tokenId: market.yesTokenId,
 *   side: 'BUY',
 *   price: Price.fromNumber(0.60),
 *   size: Quantity.fromNumber(100),
 *   status: 'PENDING',
 *   timestamp: new Date()
 * });
 * const withOrder = session.placeOrder(order);
 * console.log(withOrder.portfolio.reservedCash.amount); // 60
 *
 * // Fill order
 * const filled = withOrder.fillOrder('order-1', Quantity.fromNumber(100), Price.fromNumber(0.60));
 * console.log(filled.portfolio.getPosition(market.yesTokenId)?.totalQuantity.value); // 100
 *
 * // Update risk
 * const prices = new Map([[market.yesTokenId, Price.fromNumber(0.65)]]);
 * const limits = { maxNetPosition: 1000, maxGrossPosition: 2000, maxLossThreshold: Money.fromUSDC(100) };
 * const withRisk = filled.updateRisk(prices, 86400000, limits);
 * console.log(withRisk.riskExposure.status); // 'NORMAL'
 * ```
 */
import { Market } from '../entities/Market.js';
import { Order } from '../entities/Order.js';
import { PositionLot } from '../entities/PositionLot.js';
import { Portfolio } from './Portfolio.js';
import { RiskExposure } from './RiskExposure.js';
import { Money } from '../value-objects/Money.js';
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { TradingError } from '../../shared/errors/TradingError.js';

/**
 * Trading session invariant violation error
 *
 * @remarks
 * Thrown when session state violates business rules
 */
export class TradingSessionInvariantError extends TradingError {
  constructor(message: string) {
    super(`Trading session invariant violation: ${message}`, 'SESSION_INVARIANT_VIOLATION');
  }
}

/**
 * Order not found error
 *
 * @remarks
 * Thrown when trying to access non-existent order
 */
export class OrderNotFoundError extends TradingError {
  constructor(public readonly orderId: string) {
    super(`Order not found: ${orderId}`, 'ORDER_NOT_FOUND');
  }
}

/**
 * Risk limits for session
 */
export interface SessionRiskLimits {
  readonly maxNetPosition: number;
  readonly maxGrossPosition: number;
  readonly maxLossThreshold: Money;
}

/**
 * TradingSession aggregate root
 *
 * @remarks
 * Immutable root aggregate managing all trading state.
 * All methods return new TradingSession instances.
 */
export class TradingSession {
  /**
   * Creates a new TradingSession
   *
   * @param sessionId - Unique session identifier
   * @param market - Market being traded
   * @param portfolio - Portfolio state
   * @param riskExposure - Risk management state
   * @param activeOrders - Map of active orders (orderId -> Order)
   * @param startTime - Session start time
   * @param lastUpdateTime - Last update timestamp
   *
   * @remarks
   * Private constructor - use static factory methods instead.
   */
  private constructor(
    public readonly sessionId: string,
    public readonly market: Market,
    public readonly portfolio: Portfolio,
    public readonly riskExposure: RiskExposure,
    public readonly activeOrders: ReadonlyMap<string, Order>,
    public readonly startTime: Date,
    public readonly lastUpdateTime: Date
  ) {}

  /**
   * Creates a new trading session
   *
   * @param market - Market to trade
   * @param initialCash - Starting cash balance
   * @returns New TradingSession
   *
   * @throws {Error} If market is not active or initial cash is negative
   *
   * @remarks
   * Factory method that creates initial session state.
   * - Validates market is active and tradeable
   * - Creates portfolio with initial cash
   * - Initializes risk exposure to NORMAL
   * - Sets empty active orders map
   *
   * @example
   * ```typescript
   * const market = Market.create({
   *   id: '0x123',
   *   question: 'Will BTC hit $100k?',
   *   yesTokenId: 'yes-token',
   *   noTokenId: 'no-token',
   *   expirationDate: new Date('2024-12-31'),
   *   status: 'ACTIVE'
   * });
   *
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   * console.log(session.sessionId); // Generated UUID
   * console.log(session.portfolio.cash.amount); // 1000
   * console.log(session.riskExposure.status); // 'NORMAL'
   * ```
   */
  public static create(market: Market, initialCash: Money): TradingSession {
    // Validate market is tradeable
    if (!market.canTrade()) {
      throw new Error(`Market ${market.id} is not active for trading`);
    }

    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const portfolio = Portfolio.create(initialCash);
    const riskExposure = RiskExposure.create();

    const session = new TradingSession(
      sessionId,
      market,
      portfolio,
      riskExposure,
      new Map(),
      new Date(),
      new Date()
    );

    session.validateSessionInvariants();
    return session;
  }

  /**
   * Places an order in the session
   *
   * @param order - Order to place
   * @returns New TradingSession with order added
   *
   * @throws {Error} If order validation fails or insufficient funds
   *
   * @remarks
   * Algorithm:
   * 1. Validate order can be placed (limits, funds, market state)
   * 2. If BUY order: reserve cash = price * size
   * 3. Add order to activeOrders map
   * 4. Validate all invariants
   * 5. Return new TradingSession
   *
   * Why reserve cash?
   * - Prevents over-committing funds
   * - Reserved cash can't be used for other orders
   * - Released when order canceled or filled
   * - Ensures we can always pay for fills
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   *
   * const order = Order.create({
   *   id: 'order-1',
   *   tokenId: market.yesTokenId,
   *   side: 'BUY',
   *   price: Price.fromNumber(0.60),
   *   size: Quantity.fromNumber(100),
   *   status: 'PENDING',
   *   timestamp: new Date()
   * });
   *
   * const withOrder = session.placeOrder(order);
   * console.log(withOrder.activeOrders.size); // 1
   * console.log(withOrder.portfolio.reservedCash.amount); // 60
   * ```
   */
  public placeOrder(order: Order): TradingSession {
    // Validate order can be placed
    if (!this.canPlaceOrder(order)) {
      throw new Error(`Cannot place order ${order.id}: validation failed`);
    }

    // Validate order belongs to this market
    if (this.market.getOutcomeIndexByTokenId(order.tokenId) === null) {
      throw new Error(`Order token ${order.tokenId} does not belong to market ${this.market.id}`);
    }

    let newPortfolio = this.portfolio;

    // Reserve cash for BUY orders
    if (order.side === 'BUY') {
      const orderCost = Money.fromUSDC(order.price.value * order.size.value);
      newPortfolio = newPortfolio.reserveCash(orderCost);
    }

    // Add order to active orders
    const newActiveOrders = new Map(this.activeOrders);
    newActiveOrders.set(order.id, order);

    const session = new TradingSession(
      this.sessionId,
      this.market,
      newPortfolio,
      this.riskExposure,
      newActiveOrders,
      this.startTime,
      new Date()
    );

    session.validateSessionInvariants();
    return session;
  }

  /**
   * Cancels an active order
   *
   * @param orderId - ID of order to cancel
   * @returns New TradingSession with order canceled
   *
   * @throws {OrderNotFoundError} If order doesn't exist
   * @throws {Error} If order cannot be canceled
   *
   * @remarks
   * Algorithm:
   * 1. Find order in activeOrders
   * 2. Validate order can be canceled (PENDING or OPEN)
   * 3. If BUY order: release reserved cash
   * 4. Remove order from activeOrders
   * 5. Validate invariants
   * 6. Return new TradingSession
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(order);
   * console.log(session.portfolio.reservedCash.amount); // 60
   *
   * const canceled = session.cancelOrder('order-1');
   * console.log(canceled.activeOrders.size); // 0
   * console.log(canceled.portfolio.reservedCash.amount); // 0 (cash released)
   * ```
   */
  public cancelOrder(orderId: string): TradingSession {
    const order = this.activeOrders.get(orderId);
    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    if (!order.canCancel()) {
      throw new Error(`Order ${orderId} cannot be canceled (status: ${order.status})`);
    }

    let newPortfolio = this.portfolio;

    // Release reserved cash for BUY orders
    if (order.side === 'BUY') {
      const orderCost = Money.fromUSDC(order.price.value * order.size.value);
      newPortfolio = newPortfolio.releaseCash(orderCost);
    }

    // Remove order from active orders
    const newActiveOrders = new Map(this.activeOrders);
    newActiveOrders.delete(orderId);

    const session = new TradingSession(
      this.sessionId,
      this.market,
      newPortfolio,
      this.riskExposure,
      newActiveOrders,
      this.startTime,
      new Date()
    );

    session.validateSessionInvariants();
    return session;
  }

  /**
   * Processes order fill
   *
   * @param orderId - ID of order that filled
   * @param fillSize - Quantity filled
   * @param fillPrice - Price of fill
   * @returns New TradingSession with fill processed
   *
   * @throws {OrderNotFoundError} If order doesn't exist
   * @throws {Error} If fill is invalid
   *
   * @remarks
   * Algorithm:
   * 1. Find order in activeOrders
   * 2. Validate fill size <= remaining size
   * 3. Create position lot for the fill
   * 4. Add lot to portfolio (creates/updates position)
   * 5. If BUY: release reserved cash, reduce cash by fill cost
   * 6. If SELL: increase cash by fill proceeds
   * 7. If order fully filled: remove from activeOrders
   * 8. If partial fill: update order in activeOrders
   * 9. Validate invariants
   * 10. Return new TradingSession
   *
   * Why create lots?
   * - FIFO accounting for tax compliance
   * - Track entry price per lot for P&L
   * - Support partial position closes
   * - Accurate cost basis tracking
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(buyOrder); // BUY 100 @ 0.60
   *
   * // Order fills
   * const filled = session.fillOrder(
   *   'order-1',
   *   Quantity.fromNumber(100),
   *   Price.fromNumber(0.60)
   * );
   *
   * console.log(filled.activeOrders.size); // 0 (fully filled)
   * console.log(filled.portfolio.cash.amount); // 940 (1000 - 60)
   * console.log(filled.portfolio.reservedCash.amount); // 0
   *
   * const position = filled.portfolio.getPosition(market.yesTokenId);
   * console.log(position?.totalQuantity.value); // 100
   * console.log(position?.averageEntryPrice.value); // 0.60
   * ```
   */
  public fillOrder(orderId: string, fillSize: Quantity, fillPrice: Price): TradingSession {
    const order = this.activeOrders.get(orderId);
    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    // Validate fill size
    const remainingSize = order.getRemainingSize();
    if (fillSize.isGreaterThan(remainingSize)) {
      throw new Error(
        `Fill size ${fillSize.value} exceeds remaining size ${remainingSize.value}`
      );
    }

    let newPortfolio = this.portfolio;
    const fillCost = fillPrice.value * fillSize.value;

    // Determine side for position based on outcome index (0 → YES, 1 → NO)
    const outcomeIndex = this.market.getOutcomeIndexByTokenId(order.tokenId);
    const side = outcomeIndex === 0 ? 'YES' : 'NO';

    if (order.side === 'BUY') {
      // BUY order: release reserved cash, deduct fill cost from total cash
      const orderCost = Money.fromUSDC(order.price.value * order.size.value);
      const fillCostMoney = Money.fromUSDC(fillCost);

      // Release full order reservation
      newPortfolio = newPortfolio.releaseCash(orderCost);

      // Deduct actual fill cost from cash
      newPortfolio = newPortfolio.deductCash(fillCostMoney);

      // Create lot and add to position
      const lot = new PositionLot(
        `lot-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        order.tokenId,
        side,
        fillSize,
        fillPrice,
        new Date()
      );

      newPortfolio = newPortfolio.addPosition(order.tokenId, side, lot);
    } else {
      // SELL order: add proceeds to cash, reduce position
      const fillProceedsMoney = Money.fromUSDC(fillCost);

      // Add proceeds to cash
      newPortfolio = newPortfolio.addCash(fillProceedsMoney);

      // Remove quantity from position
      newPortfolio = newPortfolio.removePosition(order.tokenId, fillSize);
    }

    // Update or remove order
    const newActiveOrders = new Map(this.activeOrders);
    const isFullyFilled = fillSize.equals(remainingSize);

    if (isFullyFilled) {
      // Remove fully filled order
      newActiveOrders.delete(orderId);
    } else {
      // Update partially filled order
      const updatedOrder = order.withFill(
        order.filledSize ? order.filledSize.add(fillSize) : fillSize,
        fillPrice
      );
      newActiveOrders.set(orderId, updatedOrder);
    }

    const session = new TradingSession(
      this.sessionId,
      this.market,
      newPortfolio,
      this.riskExposure,
      newActiveOrders,
      this.startTime,
      new Date()
    );

    session.validateSessionInvariants();
    return session;
  }

  /**
   * Updates risk exposure based on current state
   *
   * @param prices - Current market prices (tokenId -> Price)
   * @param timeToExpiry - Milliseconds until market expires
   * @param limits - Risk limits configuration
   * @returns New TradingSession with updated risk
   *
   * @remarks
   * Algorithm:
   * 1. Calculate unrealized P&L from portfolio
   * 2. Check if should panic (loss threshold exceeded)
   * 3. Check position limits (net, gross)
   * 4. Calculate urgency based on time and position
   * 5. Update risk exposure with new state
   * 6. Return new TradingSession
   *
   * Should be called:
   * - After every fill
   * - Periodically (e.g., every minute)
   * - When prices change significantly
   * - When approaching expiry
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(order)
   *   .fillOrder('order-1', Quantity.fromNumber(100), Price.fromNumber(0.60));
   *
   * const prices = new Map([[market.yesTokenId, Price.fromNumber(0.70)]]);
   * const limits = {
   *   maxNetPosition: 1000,
   *   maxGrossPosition: 2000,
   *   maxLossThreshold: Money.fromUSDC(100)
   * };
   *
   * const withRisk = session.updateRisk(prices, 86400000, limits);
   * console.log(withRisk.riskExposure.status); // 'NORMAL'
   * console.log(withRisk.riskExposure.urgency); // ~0.04
   * ```
   */
  public updateRisk(
    prices: Map<string, Price>,
    timeToExpiry: number,
    limits: SessionRiskLimits
  ): TradingSession {
    // Calculate unrealized P&L
    const unrealizedPnL = this.portfolio.calculateUnrealizedPnL(prices);

    // Check for panic condition
    let newRiskExposure = this.riskExposure;
    if (this.riskExposure.shouldPanic(unrealizedPnL, limits.maxLossThreshold)) {
      newRiskExposure = newRiskExposure.updateMode(
        'PANIC',
        `Unrealized loss $${Math.abs(unrealizedPnL.amount).toFixed(2)} exceeds threshold $${limits.maxLossThreshold.amount.toFixed(2)}`
      );
    }

    // Check position limits
    newRiskExposure = newRiskExposure.checkLimits(
      this.portfolio,
      limits.maxNetPosition,
      limits.maxGrossPosition
    );

    // Calculate and update urgency
    const urgency = newRiskExposure.calculateUrgency(
      timeToExpiry,
      Math.abs(this.portfolio.netPosition),
      limits.maxNetPosition
    );

    newRiskExposure = newRiskExposure.updateUrgency(
      urgency,
      `Time: ${(timeToExpiry / 3600000).toFixed(1)}h, Position: ${Math.abs(this.portfolio.netPosition)}/${limits.maxNetPosition}`
    );

    const session = new TradingSession(
      this.sessionId,
      this.market,
      this.portfolio,
      newRiskExposure,
      this.activeOrders,
      this.startTime,
      new Date()
    );

    session.validateSessionInvariants();
    return session;
  }

  /**
   * Validates if order can be placed
   *
   * @param order - Order to validate
   * @returns True if order can be placed
   *
   * @remarks
   * Validation checks:
   * 1. Market is active and not expired
   * 2. Order is for correct market tokens
   * 3. Portfolio has sufficient funds (for BUY)
   * 4. Risk limits allow order (not in PANIC mode)
   * 5. Order is not already in activeOrders
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   *
   * const canPlace = session.canPlaceOrder(order);
   * if (canPlace) {
   *   const withOrder = session.placeOrder(order);
   * }
   * ```
   */
  public canPlaceOrder(order: Order): boolean {
    // Check market is tradeable
    if (!this.market.canTrade()) {
      return false;
    }

    // Check token belongs to market
    if (this.market.getOutcomeIndexByTokenId(order.tokenId) === null) {
      return false;
    }

    // Check sufficient funds for BUY orders
    if (order.side === 'BUY') {
      if (!this.portfolio.canAffordOrder(order.price, order.size)) {
        return false;
      }
    } else {
      // For SELL orders, check we have position
      const position = this.portfolio.getPosition(order.tokenId);
      if (!position || position.totalQuantity.isLessThan(order.size)) {
        return false;
      }
    }

    // Check not in PANIC mode (can't place new orders)
    if (this.riskExposure.isPanic()) {
      return false;
    }

    // Check order not already active
    if (this.activeOrders.has(order.id)) {
      return false;
    }

    return true;
  }

  /**
   * Gets active orders for specific token
   *
   * @param tokenId - Token ID to filter by
   * @returns Array of orders for that token
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(yesOrder)
   *   .placeOrder(noOrder);
   *
   * const yesOrders = session.getActiveOrdersForToken(market.yesTokenId);
   * console.log(yesOrders.length); // 1
   * ```
   */
  public getActiveOrdersForToken(tokenId: string): Order[] {
    const orders: Order[] = [];
    for (const order of this.activeOrders.values()) {
      if (order.tokenId === tokenId) {
        orders.push(order);
      }
    }
    return orders;
  }

  /**
   * Gets total reserved cash from active orders
   *
   * @returns Total reserved cash
   *
   * @remarks
   * Should match portfolio.reservedCash (validated in invariants)
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(order1) // BUY 100 @ 0.60 = 60
   *   .placeOrder(order2); // BUY 50 @ 0.70 = 35
   *
   * const reserved = session.getTotalReservedCash();
   * console.log(reserved.amount); // 95
   * ```
   */
  public getTotalReservedCash(): Money {
    let total = 0;
    for (const order of this.activeOrders.values()) {
      if (order.side === 'BUY') {
        total += order.getNotional();
      }
    }
    return Money.fromUSDC(total);
  }

  /**
   * Validates all business rules and invariants
   *
   * @throws {TradingSessionInvariantError} If any invariant is violated
   *
   * @remarks
   * Business rules:
   * 1. Market must be valid and active
   * 2. Portfolio must be valid
   * 3. Risk exposure must be valid
   * 4. All active orders must be valid
   * 5. Reserved cash must match sum of BUY order notionals
   * 6. All orders must belong to this market
   * 7. Start time must be before last update time
   * 8. Session ID must be non-empty
   *
   * Called automatically after every state change.
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   * session.validateSessionInvariants(); // OK
   * ```
   */
  public validateSessionInvariants(): void {
    // Rule 1: Market must be valid
    if (!this.market || !this.market.id) {
      throw new TradingSessionInvariantError('Market must be valid');
    }

    // Rule 2: Portfolio must be valid
    try {
      this.portfolio.validateInvariants();
    } catch (error) {
      throw new TradingSessionInvariantError(`Portfolio invalid: ${error}`);
    }

    // Rule 3: Risk exposure must be valid
    try {
      this.riskExposure.validateInvariants();
    } catch (error) {
      throw new TradingSessionInvariantError(`Risk exposure invalid: ${error}`);
    }

    // Rule 4: All active orders must be valid
    for (const [orderId, order] of this.activeOrders) {
      if (order.id !== orderId) {
        throw new TradingSessionInvariantError(
          `Order ID mismatch: map key ${orderId} vs order.id ${order.id}`
        );
      }

      try {
        order.validate();
      } catch (error) {
        throw new TradingSessionInvariantError(`Order ${orderId} invalid: ${error}`);
      }
    }

    // Rule 5: Reserved cash must match sum of BUY order notionals
    const calculatedReserved = this.getTotalReservedCash();
    if (!calculatedReserved.equals(this.portfolio.reservedCash)) {
      throw new TradingSessionInvariantError(
        `Reserved cash mismatch: calculated $${calculatedReserved.amount} vs portfolio $${this.portfolio.reservedCash.amount}`
      );
    }

    // Rule 6: All orders must belong to this market
    for (const order of this.activeOrders.values()) {
      if (this.market.getOutcomeIndexByTokenId(order.tokenId) === null) {
        throw new TradingSessionInvariantError(
          `Order ${order.id} token ${order.tokenId} does not belong to market ${this.market.id}`
        );
      }
    }

    // Rule 7: Start time must be before last update time
    if (this.startTime.getTime() > this.lastUpdateTime.getTime()) {
      throw new TradingSessionInvariantError(
        'Start time cannot be after last update time'
      );
    }

    // Rule 8: Session ID must be non-empty
    if (!this.sessionId || this.sessionId.trim().length === 0) {
      throw new TradingSessionInvariantError('Session ID cannot be empty');
    }
  }

  /**
   * Gets session duration in milliseconds
   *
   * @returns Duration since session start
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   * // ... trading happens ...
   * const duration = session.getDuration();
   * console.log(`Session running for ${duration}ms`);
   * ```
   */
  public getDuration(): number {
    return this.lastUpdateTime.getTime() - this.startTime.getTime();
  }

  /**
   * Checks if session has any active positions
   *
   * @returns True if portfolio has positions
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   * console.log(session.hasActivePositions()); // false
   *
   * const withPosition = session.placeOrder(order).fillOrder(...);
   * console.log(withPosition.hasActivePositions()); // true
   * ```
   */
  public hasActivePositions(): boolean {
    return !this.portfolio.isEmpty();
  }

  /**
   * Checks if session has any active orders
   *
   * @returns True if there are active orders
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000));
   * console.log(session.hasActiveOrders()); // false
   *
   * const withOrder = session.placeOrder(order);
   * console.log(withOrder.hasActiveOrders()); // true
   * ```
   */
  public hasActiveOrders(): boolean {
    return this.activeOrders.size > 0;
  }

  /**
   * Creates a string representation of trading session
   *
   * @returns Formatted string with session summary
   *
   * @example
   * ```typescript
   * const session = TradingSession.create(market, Money.fromUSDC(1000))
   *   .placeOrder(order);
   * console.log(session.toString());
   * // "TradingSession[session-123]: Market[0x123] - 1 orders, 0 positions - RiskExposure: NORMAL/QUOTE"
   * ```
   */
  public toString(): string {
    return `TradingSession[${this.sessionId}]: Market[${this.market.id}] - ${this.activeOrders.size} orders, ${this.portfolio.positions.size} positions - ${this.riskExposure.toString()}`;
  }
}
