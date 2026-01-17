/**
 * Barrel экспорт доменных ошибок
 *
 * @remarks
 * Экспортирует все пользовательские типы ошибок.
 */
export {
  TradingError,
  InsufficientFundsError,
  OrderValidationError,
  PositionLimitExceededError,
  MarketNotFoundError,
  InvalidPriceError,
  InvalidQuantityError,
  ExchangeError
} from './TradingError.js';
