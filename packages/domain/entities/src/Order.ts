/**
 * Order entity
 *
 * @remarks
 * Represents an order in the prediction market trading system.
 * Orders are immutable entities with readonly properties.
 *
 * ### Business Rules:
 * 1. Order must have valid tokenId, price, and size
 * 2. Price must be within valid range [0.01, 0.99]
 * 3. Size must be >= minimum quantity
 * 4. Filled size cannot exceed original size
 * 5. Average fill price must be valid if order is partially/fully filled
 * 6. Only PENDING or OPEN orders can be canceled
 *
 * ### Order Lifecycle:
 * PENDING → OPEN → FILLED (or CANCELED/REJECTED)
 *
 * @example
 * ```typescript
 * // Create a new buy order
 * const order = Order.create({
 *   id: '0x123...',
 *   tokenId: 'token-yes',
 *   side: 'BUY',
 *   price: Price.fromNumber(0.65),
 *   size: Quantity.fromNumber(100),
 *   status: 'PENDING',
 *   timestamp: new Date()
 * });
 *
 * // Check if order can be canceled
 * if (order.canCancel()) {
 *   console.log('Order can be canceled');
 * }
 *
 * // Calculate notional value
 * const notional = order.getNotional();
 * console.log(`Notional: ${notional}`); // 65.00 (100 * 0.65)
 * ```
 */
import { Price } from '@polymarket/value-objects';
import { Quantity } from '@polymarket/value-objects';
import { OrderValidationError } from '@polymarket/errors';
import type { ExecutionEvent, OrderAccepted } from '../events/ExecutionEvent.js';
import { OrderExecutionState, isAllowedTransition } from '../execution/OrderExecutionState.js';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';

/**
 * Order side type
 */
export type OrderSide = 'BUY' | 'SELL';

/**
 * Order status type
 */
export type OrderStatus = 'PENDING' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED';

/**
 * Order creation parameters
 *
 * @remarks
 * v4.2 (Фаза 4): strategyId для multi-strategy изоляции
 */
export interface OrderParams {
  id: string;
  tokenId: string;
  side: OrderSide;
  price: Price;
  size: Quantity;
  status: OrderStatus;
  timestamp: Date;
  strategyId?: string; // v4.2: для multi-strategy изоляции (optional для обратной совместимости)
  filledSize?: Quantity;
  averageFillPrice?: Price;
}

/**
 * Order entity class
 *
 * @remarks
 * Immutable domain entity representing a trading order.
 * All properties are readonly to ensure immutability.
 */
export class Order {
  public readonly id: string;
  public readonly tokenId: string;
  public readonly side: OrderSide;
  public readonly price: Price;
  public readonly size: Quantity;
  public readonly status: OrderStatus;
  public readonly timestamp: Date;
  public readonly strategyId?: string; // v4.2: для multi-strategy изоляции
  public readonly filledSize?: Quantity;
  public readonly averageFillPrice?: Price;

  private constructor(params: OrderParams) {
    this.id = params.id;
    this.tokenId = params.tokenId;
    this.side = params.side;
    this.price = params.price;
    this.size = params.size;
    this.status = params.status;
    this.timestamp = params.timestamp;
    this.strategyId = params.strategyId; // v4.2: propagate strategyId
    this.filledSize = params.filledSize;
    this.averageFillPrice = params.averageFillPrice;
  }

  /**
   * Creates a new Order instance
   *
   * @param params - Order creation parameters
   * @returns Order instance
   * @throws {OrderValidationError} If validation fails
   *
   * @remarks
   * Factory method that creates and validates an Order.
   * Performs comprehensive validation of all business rules.
   *
   * @example
   * ```typescript
   * const order = Order.create({
   *   id: '0x123abc',
   *   tokenId: 'token-yes-123',
   *   side: 'BUY',
   *   price: Price.fromNumber(0.55),
   *   size: Quantity.fromNumber(50),
   *   status: 'PENDING',
   *   timestamp: new Date()
   * });
   * ```
   */
  public static create(params: OrderParams): Order {
    const order = new Order(params);
    order.validate();
    return order;
  }

  /**
   * Создаёт новый Order aggregate из OrderAccepted event
   *
   * @param event - OrderAccepted event
   * @returns Result<Order, string>
   *
   * @remarks
   * OrderAccepted содержит minimal context (side, marketId, price, size)
   * NO Pending Orders Registry - ExecutionEvent self-contained
   *
   * Invariant checks:
   * - price > 0
   * - size > 0
   * - marketId non-empty
   *
   * @example
   * ```typescript
   * const event: OrderAccepted = {
   *   type: 'OrderAccepted',
   *   orderId: '123',
   *   side: 'BUY',
   *   marketId: 'abc',
   *   price: 100,
   *   size: 10
   * };
   *
   * const result = Order.fromOrderAccepted(event);
   * if (result.ok) {
   *   console.log('Order created:', result.value.id);
   * } else {
   *   console.error('Invariant violation:', result.error);
   * }
   * ```
   */
  public static fromOrderAccepted(event: OrderAccepted): Result<Order, string> {
    // Invariant checks в aggregate, NOT в mapper
    if (event.price <= 0) {
      return Err(`Invariant violation: price ${event.price} <= 0 for order ${event.orderId}`);
    }

    if (event.size <= 0) {
      return Err(`Invariant violation: size ${event.size} <= 0 for order ${event.orderId}`);
    }

    if (!event.marketId || event.marketId.trim().length === 0) {
      return Err(`Invariant violation: marketId empty for order ${event.orderId}`);
    }

    try {
      const order = Order.create({
        id: event.orderId,
        tokenId: event.marketId,
        side: event.side,
        price: Price.fromNumber(event.price),
        size: Quantity.fromNumber(event.size),
        status: 'OPEN', // OrderAccepted → OPEN state
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0), // Initial state
      });

      return Ok(order);
    } catch (error) {
      return Err(`Failed to create Order from OrderAccepted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Применяет ExecutionEvent к Order aggregate
   *
   * @param event - ExecutionEvent для применения
   * @returns Result<Order, string> - успех или ошибка с нарушением invariant
   *
   * @remarks
   * aggregate logic (invariants, FSM transitions, derived values)
   *
   * Responsibilities:
   * - Вычисление totalFilled из filledDelta
   * - Invariant checks (filledDelta > 0, price > 0, totalFilled <= size)
   * - FSM transitions (OPEN → PARTIALLY_FILLED → FILLED)
   * - Weighted average fillPrice (если multiple fills)
   * - Derived values (remaining = size - totalFilled)
   *
   * FSM transitions проверяются через isAllowedTransition()
   * - Aggregate проверяет: текущий status → target status = allowed?
   * - Invalid transition = Result.fail()
   *
   * Projector НЕ должен содержать эту логику - он только вызывает applyExecutionEvent()
   *
   * @example
   * ```typescript
   * const event: OrderPartiallyFilled = {
   *   type: 'OrderPartiallyFilled',
   *   orderId: '123',
   *   filledDelta: 50,
   *   price: 100
   * };
   *
   * const result = order.applyExecutionEvent(event);
   * if (result.ok) {
   *   const updatedOrder = result.value;
   *   console.log('Order updated:', updatedOrder.status);
   * } else {
   *   console.error('Failed to apply event:', result.error);
   * }
   * ```
   */
  public applyExecutionEvent(event: ExecutionEvent): Result<Order, string> {
    switch (event.type) {
      case 'OrderAccepted':
        // OrderAccepted не применяется к существующему Order
        // Order создаётся через Order.fromOrderAccepted()
        return Err(`Cannot apply OrderAccepted to existing order ${this.id}`);

      // ✅ v7.7.15: OrderPartiallyFilled УДАЛЁН - стратегия работает только по StrategyTick!
      // case 'OrderPartiallyFilled': { ... }

      // ✅ v7.7.15: OrderFilled УДАЛЁН - стратегия работает только по StrategyTick!
      // case 'OrderFilled': { ... }

      case 'OrderCancelled': {
        // FSM transition check
        const currentState = this.mapStatusToExecutionState(this.status);
        const targetState = OrderExecutionState.CANCELED;

        if (!isAllowedTransition(currentState, targetState)) {
          return Err(
            `FSM violation: transition ${currentState} → ${targetState} not allowed for order ${this.id}`
          );
        }

        try {
          const updatedOrder = Order.create({
            id: this.id,
            tokenId: this.tokenId,
            side: this.side,
            price: this.price,
            size: this.size,
            status: 'CANCELED',
            timestamp: this.timestamp,
            filledSize: this.filledSize,
            averageFillPrice: this.averageFillPrice,
          });

          return Ok(updatedOrder);
        } catch (error) {
          return Err(`Failed to create updated Order: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      case 'OrderRejected': {
        // FSM transition check
        const currentState = this.mapStatusToExecutionState(this.status);
        const targetState = OrderExecutionState.REJECTED;

        if (!isAllowedTransition(currentState, targetState)) {
          return Err(
            `FSM violation: transition ${currentState} → ${targetState} not allowed for order ${this.id}`
          );
        }

        try {
          const updatedOrder = Order.create({
            id: this.id,
            tokenId: this.tokenId,
            side: this.side,
            price: this.price,
            size: this.size,
            status: 'REJECTED',
            timestamp: this.timestamp,
            filledSize: this.filledSize,
            averageFillPrice: this.averageFillPrice,
          });

          return Ok(updatedOrder);
        } catch (error) {
          return Err(`Failed to create updated Order: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      default: {
        const _exhaustive: never = event;
        return Err(`Unhandled ExecutionEvent: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * Вычисляет weighted average fill price
   *
   * @param previousFilled - Предыдущий заполненный объём
   * @param previousAvgPrice - Предыдущая средняя цена
   * @param filledDelta - Новый заполненный объём (delta)
   * @param currentPrice - Цена текущего fill
   * @returns Weighted average price
   *
   * @remarks
   * используется для multiple fills
   *
   * Формула: (previousFilled * previousAvgPrice + filledDelta * currentPrice) / totalFilled
   *
   * @example
   * ```typescript
   * // First fill: 50 @ 100
   * const avgPrice1 = calculateWeightedAveragePrice(0, 0, 50, 100); // 100
   *
   * // Second fill: 30 @ 110
   * const avgPrice2 = calculateWeightedAveragePrice(50, 100, 30, 110); // 103.75
   * ```
   */
  // @ts-expect-error - utility method for future use
  private _calculateWeightedAveragePrice(
    previousFilled: number,
    previousAvgPrice: number,
    filledDelta: number,
    currentPrice: number
  ): number {
    if (previousFilled === 0) {
      return currentPrice;
    }

    const totalFilled = previousFilled + filledDelta;
    return (previousFilled * previousAvgPrice + filledDelta * currentPrice) / totalFilled;
  }

  /**
   * Маппит OrderStatus → OrderExecutionState для FSM transitions
   *
   * @param status - OrderStatus
   * @returns OrderExecutionState
   *
   * @remarks
   * используется для FSM validation в applyExecutionEvent()
   *
   * Mapping:
   * - PENDING → OPEN (считаем как OPEN для FSM)
   * - OPEN → OPEN
   * - FILLED → FILLED
   * - CANCELED → CANCELED
   * - REJECTED → CANCELED (считаем как CANCELED для FSM)
   */
  private mapStatusToExecutionState(status: OrderStatus): OrderExecutionState {
    switch (status) {
      case 'PENDING':
      case 'OPEN':
        return OrderExecutionState.OPEN;
      case 'FILLED':
        return OrderExecutionState.FILLED;
      case 'CANCELED':
      case 'REJECTED':
        return OrderExecutionState.CANCELED;
      default:
        return OrderExecutionState.OPEN; // Default fallback
    }
  }

  /**
   * Validates order against business rules
   *
   * @throws {OrderValidationError} If any validation rule fails
   *
   * @remarks
   * Validates the following rules:
   * 1. ID must be non-empty string
   * 2. TokenId must be non-empty string
   * 3. Side must be 'BUY' or 'SELL'
   * 4. Status must be valid OrderStatus
   * 5. Size must be positive
   * 6. FilledSize (if present) cannot exceed original size
   * 7. AverageFillPrice must be valid if filledSize > 0
   * 8. Timestamp must be valid Date
   *
   * @example
   * ```typescript
   * try {
   *   order.validate();
   * } catch (error) {
   *   if (error instanceof OrderValidationError) {
   *     console.error(`Validation failed: ${error.message}`);
   *   }
   * }
   * ```
   */
  public validate(): void {
    // Validate ID
    if (!this.id || typeof this.id !== 'string' || this.id.trim().length === 0) {
      throw new OrderValidationError('Order ID must be a non-empty string', 'id');
    }

    // Validate tokenId
    if (!this.tokenId || typeof this.tokenId !== 'string' || this.tokenId.trim().length === 0) {
      throw new OrderValidationError('Token ID must be a non-empty string', 'tokenId');
    }

    // Validate side
    if (this.side !== 'BUY' && this.side !== 'SELL') {
      throw new OrderValidationError(`Invalid order side: ${this.side}`, 'side');
    }

    // Validate status
    const validStatuses: OrderStatus[] = ['PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED'];
    if (!validStatuses.includes(this.status)) {
      throw new OrderValidationError(`Invalid order status: ${this.status}`, 'status');
    }

    // Validate size is positive
    if (!this.size.isPositive()) {
      throw new OrderValidationError('Order size must be positive', 'size');
    }

    // Validate filledSize if present
    if (this.filledSize) {
      if (this.filledSize.isGreaterThan(this.size)) {
        throw new OrderValidationError(
          `Filled size (${this.filledSize.value}) cannot exceed order size (${this.size.value})`,
          'filledSize'
        );
      }
    }

    // Validate averageFillPrice if filledSize > 0
    if (this.filledSize && this.filledSize.isPositive() && !this.averageFillPrice) {
      throw new OrderValidationError(
        'Average fill price is required when filled size > 0',
        'averageFillPrice'
      );
    }

    // Validate timestamp
    if (!(this.timestamp instanceof Date) || isNaN(this.timestamp.getTime())) {
      throw new OrderValidationError('Invalid timestamp', 'timestamp');
    }
  }

  /**
   * Checks if order is fully filled
   *
   * @returns True if order status is FILLED
   *
   * @remarks
   * A filled order has completed execution.
   * All requested size has been matched.
   *
   * @example
   * ```typescript
   * if (order.isFilled()) {
   *   console.log('Order completed');
   * }
   * ```
   */
  public isFilled(): boolean {
    return this.status === 'FILLED';
  }

  /**
   * Checks if order is open
   *
   * @returns True if order status is OPEN
   *
   * @remarks
   * An open order is actively in the order book
   * and waiting for execution.
   *
   * @example
   * ```typescript
   * if (order.isOpen()) {
   *   console.log('Order is active in the book');
   * }
   * ```
   */
  public isOpen(): boolean {
    return this.status === 'OPEN';
  }

  /**
   * Checks if order is pending
   *
   * @returns True if order status is PENDING
   *
   * @remarks
   * A pending order has been submitted but not yet
   * accepted by the exchange.
   *
   * @example
   * ```typescript
   * if (order.isPending()) {
   *   console.log('Order awaiting exchange acceptance');
   * }
   * ```
   */
  public isPending(): boolean {
    return this.status === 'PENDING';
  }

  /**
   * Checks if order can be canceled
   *
   * @returns True if order is PENDING or OPEN
   *
   * @remarks
   * Only orders that are PENDING or OPEN can be canceled.
   * FILLED, CANCELED, and REJECTED orders cannot be canceled.
   *
   * Business rule: Terminal states (FILLED, CANCELED, REJECTED)
   * are immutable and cannot transition to other states.
   *
   * @example
   * ```typescript
   * if (order.canCancel()) {
   *   await exchangeService.cancelOrder(order.id);
   * } else {
   *   console.log('Order cannot be canceled');
   * }
   * ```
   */
  public canCancel(): boolean {
    return this.status === 'PENDING' || this.status === 'OPEN';
  }

  /**
   * Calculates the notional value of the order
   *
   * @returns Notional value (price * size)
   *
   * @remarks
   * Notional = Price × Size
   *
   * For BUY orders: This is the maximum amount needed to fill the order
   * For SELL orders: This is the amount received if order fills
   *
   * Example:
   * - Price: 0.65
   * - Size: 100
   * - Notional: 65.00
   *
   * @example
   * ```typescript
   * const order = Order.create({
   *   id: '123',
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   price: Price.fromNumber(0.65),
   *   size: Quantity.fromNumber(100),
   *   status: 'PENDING',
   *   timestamp: new Date()
   * });
   *
   * const notional = order.getNotional();
   * console.log(notional); // 65.0
   * ```
   */
  public getNotional(): number {
    return this.price.value * this.size.value;
  }

  /**
   * Gets the remaining unfilled size
   *
   * @returns Remaining quantity to be filled
   *
   * @remarks
   * Calculates: Original Size - Filled Size
   *
   * Returns original size if no fills have occurred.
   * Returns zero if order is fully filled.
   *
   * @example
   * ```typescript
   * const order = Order.create({
   *   id: '123',
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   price: Price.fromNumber(0.55),
   *   size: Quantity.fromNumber(100),
   *   status: 'OPEN',
   *   timestamp: new Date(),
   *   filledSize: Quantity.fromNumber(40)
   * });
   *
   * const remaining = order.getRemainingSize();
   * console.log(remaining.value); // 60
   * ```
   */
  public getRemainingSize(): Quantity {
    if (!this.filledSize || this.filledSize.isZero()) {
      return this.size;
    }
    return this.size.subtract(this.filledSize);
  }

  /**
   * Checks if order is partially filled
   *
   * @returns True if 0 < filledSize < size
   *
   * @remarks
   * A partially filled order has some execution but is not complete.
   *
   * @example
   * ```typescript
   * if (order.isPartiallyFilled()) {
   *   const remaining = order.getRemainingSize();
   *   console.log(`${remaining.value} shares remaining`);
   * }
   * ```
   */
  public isPartiallyFilled(): boolean {
    if (!this.filledSize) {
      return false;
    }
    return this.filledSize.isPositive() && this.filledSize.isLessThan(this.size);
  }

  /**
   * Gets fill percentage
   *
   * @returns Fill percentage (0-100)
   *
   * @remarks
   * Calculates: (FilledSize / Size) × 100
   *
   * Returns 0 if no fills.
   * Returns 100 if fully filled.
   *
   * @example
   * ```typescript
   * const fillPct = order.getFillPercentage();
   * console.log(`Order ${fillPct.toFixed(1)}% filled`);
   * ```
   */
  public getFillPercentage(): number {
    if (!this.filledSize || this.filledSize.isZero()) {
      return 0;
    }
    return (this.filledSize.value / this.size.value) * 100;
  }

  /**
   * Creates a new order with updated status
   *
   * @param status - New order status
   * @returns New Order instance with updated status
   *
   * @remarks
   * Creates a new immutable Order instance with changed status.
   * Original order remains unchanged (immutability).
   *
   * @example
   * ```typescript
   * const pendingOrder = Order.create({...});
   * const openOrder = pendingOrder.withStatus('OPEN');
   * ```
   */
  public withStatus(status: OrderStatus): Order {
    return Order.create({
      ...this,
      status
    });
  }

  /**
   * Creates a new order with filled size and average price
   *
   * @param filledSize - Filled quantity
   * @param averageFillPrice - Average execution price
   * @returns New Order instance with fill information
   * @throws {OrderValidationError} If filled size exceeds order size
   *
   * @remarks
   * Creates a new immutable Order with execution details.
   * Automatically sets status to FILLED if fully executed.
   *
   * @example
   * ```typescript
   * const openOrder = Order.create({...});
   * const filledOrder = openOrder.withFill(
   *   Quantity.fromNumber(100),
   *   Price.fromNumber(0.55)
   * );
   * ```
   */
  public withFill(filledSize: Quantity, averageFillPrice: Price): Order {
    const isFullyFilled = filledSize.equals(this.size) || filledSize.isGreaterThan(this.size);

    return Order.create({
      ...this,
      filledSize,
      averageFillPrice,
      status: isFullyFilled ? 'FILLED' : this.status
    });
  }

  /**
   * Converts order to plain object
   *
   * @returns Plain object representation
   *
   * @remarks
   * Useful for serialization, logging, or API responses.
   *
   * @example
   * ```typescript
   * const orderData = order.toJSON();
   * console.log(JSON.stringify(orderData, null, 2));
   * ```
   */
  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      tokenId: this.tokenId,
      side: this.side,
      price: this.price.value,
      size: this.size.value,
      status: this.status,
      timestamp: this.timestamp.toISOString(),
      filledSize: this.filledSize?.value,
      averageFillPrice: this.averageFillPrice?.value,
      notional: this.getNotional(),
      remainingSize: this.getRemainingSize().value,
      fillPercentage: this.getFillPercentage()
    };
  }

  /**
   * Converts order to string representation
   *
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * console.log(order.toString());
   * // Output: "Order[0x123]: BUY 100 @ 0.5500 (OPEN)"
   * ```
   */
  public toString(): string {
    return `Order[${this.id}]: ${this.side} ${this.size.value} @ ${this.price.toString()} (${this.status})`;
  }
}
