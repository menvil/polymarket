/**
 * Barrel экспорт сущностей
 *
 * @remarks
 * Экспортирует все доменные сущности для удобного импорта.
 * Сущности имеют идентичность и жизненный цикл.
 */
export { Market } from './Market.js';
export type { MarketStatus, OutcomeIndex, OutcomeToken, MarketProps } from './Market.js';

export { Order } from './Order.js';
export type { OrderSide, OrderStatus, OrderParams } from './Order.js';

export { Position, InsufficientPositionError, LotNotFoundError } from './Position.js';

export { PositionLot, InsufficientLotQuantityError } from './PositionLot.js';
export type { Side } from './PositionLot.js';

// Portfolio экспортируется из aggregates, а не из entities
// export { Portfolio, DuplicatePositionError, PositionNotFoundError } from './Portfolio.js';
//export { DuplicatePositionError, PositionNotFoundError } from './Portfolio.js';

export { Orderbook } from './Orderbook.js';
export type { OrderbookLevel, OrderbookData } from './Orderbook.js';

export { Trade, TradeValidationError } from './Trade.js';
export type { TradeSide, TradeParams } from './Trade.js';
