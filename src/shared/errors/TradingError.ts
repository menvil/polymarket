/**
 * Базовый класс торговых ошибок
 *
 * @remarks
 * Все доменные ошибки должны наследовать этот класс.
 * Обеспечивает структурированную обработку ошибок с кодами.
 */
export class TradingError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = new Date();

    // captureStackTrace - специфичный для V8 API (Node.js, Chrome)
    // Fallback для сред без V8 (Firefox, Safari)
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = new Error().stack;
    }
  }
}

/**
 * Ошибка недостаточных средств
 *
 * @remarks
 * Выбрасывается при попытке разместить ордер без достаточного баланса.
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
 * Ошибка валидации ордера
 *
 * @remarks
 * Выбрасывается когда параметры ордера невалидны.
 */
export class OrderValidationError extends TradingError {
  constructor(message: string, public readonly field?: string) {
    super(message, 'ORDER_VALIDATION_ERROR');
  }
}

/**
 * Ошибка превышения лимита позиции
 *
 * @remarks
 * Выбрасывается при попытке превысить риск-лимиты.
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
 * Ошибка рынок не найден
 *
 * @remarks
 * Выбрасывается при попытке доступа к несуществующему рынку.
 */
export class MarketNotFoundError extends TradingError {
  constructor(public readonly marketId: string) {
    super(`Market not found: ${marketId}`, 'MARKET_NOT_FOUND');
  }
}

/**
 * Ошибка невалидной цены
 *
 * @remarks
 * Выбрасывается когда цена вне допустимого диапазона [0.0001, 0.9999].
 */
export class InvalidPriceError extends TradingError {
  constructor(
    public readonly price: number,
    minPrice: number = 0.0001,
    maxPrice: number = 0.9999
  ) {
    super(
      `Invalid price: ${price}. Must be between ${minPrice} and ${maxPrice}`,
      'INVALID_PRICE'
    );
  }
}

/**
 * Ошибка невалидного количества
 *
 * @remarks
 * Выбрасывается когда количество невалидно (отрицательное, ноль или слишком маленькое).
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
 * Ошибка биржи
 *
 * @remarks
 * Выбрасывается когда API биржи возвращает ошибку.
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
