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
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { OrderValidationError } from '../../shared/errors/TradingError.js';

/**
 * Order side type
 */
export type OrderSide = 'BUY' | 'SELL';

/**
 * Order status type
 */
export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'CANCELED' | 'REJECTED';

/**
 * Order creation parameters
 */
export interface OrderParams {
  id: string;
  tokenId: string;
  side: OrderSide;
  price: Price;
  size: Quantity;
  status: OrderStatus;
  timestamp: Date;
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
    const validStatuses: OrderStatus[] = ['PENDING', 'OPEN', 'FILLED', 'CANCELED', 'REJECTED'];
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
