/**
 * Base trading error class
 * 
 * @remarks
 * All domain errors should extend this class.
 * Provides structured error handling with error codes.
 */
export class TradingError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = new Date();
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Insufficient funds error
 * 
 * @remarks
 * Thrown when trying to place an order without sufficient cash balance.
 */
export class InsufficientFundsError extends TradingError {
  constructor(
    public readonly required: number,
    public readonly available: number
  ) {
    super(
      `Insufficient funds: required $${required.toFixed(2)}, available $${available.toFixed(2)}`,
      'INSUFFICIENT_FUNDS'
    );
  }
}

/**
 * Order validation error
 * 
 * @remarks
 * Thrown when order parameters are invalid.
 */
export class OrderValidationError extends TradingError {
  constructor(message: string, public readonly field?: string) {
    super(message, 'ORDER_VALIDATION_ERROR');
  }
}

/**
 * Position limit exceeded error
 * 
 * @remarks
 * Thrown when trying to exceed risk limits.
 */
export class PositionLimitExceededError extends TradingError {
  constructor(
    message: string,
    public readonly currentPosition: number,
    public readonly limit: number
  ) {
    super(message, 'POSITION_LIMIT_EXCEEDED');
  }
}

/**
 * Market not found error
 * 
 * @remarks
 * Thrown when trying to access non-existent market.
 */
export class MarketNotFoundError extends TradingError {
  constructor(public readonly marketId: string) {
    super(`Market not found: ${marketId}`, 'MARKET_NOT_FOUND');
  }
}

/**
 * Invalid price error
 * 
 * @remarks
 * Thrown when price is outside valid range [0.01, 0.99].
 */
export class InvalidPriceError extends TradingError {
  constructor(public readonly price: number) {
    super(
      `Invalid price: ${price}. Must be between 0.01 and 0.99`,
      'INVALID_PRICE'
    );
  }
}

/**
 * Invalid quantity error
 * 
 * @remarks
 * Thrown when quantity is invalid (negative, zero, or too small).
 */
export class InvalidQuantityError extends TradingError {
  constructor(public readonly quantity: number, public readonly minSize: number) {
    super(
      `Invalid quantity: ${quantity}. Must be >= ${minSize}`,
      'INVALID_QUANTITY'
    );
  }
}

/**
 * Exchange error
 * 
 * @remarks
 * Thrown when exchange API returns an error.
 */
export class ExchangeError extends TradingError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: unknown
  ) {
    super(message, 'EXCHANGE_ERROR');
  }
}
