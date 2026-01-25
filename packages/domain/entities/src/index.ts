/**
 * Entities barrel export
 *
 * @remarks
 * Exports all domain entities for convenient importing.
 * Entities have identity and lifecycle.
 */
export { Market } from './Market.js';
export type { MarketStatus, OutcomeIndex, OutcomeToken, MarketProps } from './Market.js';

export { Order } from './Order.js';
export type { OrderSide, OrderStatus, OrderParams } from './Order.js';

export { Position, InsufficientPositionError, LotNotFoundError } from './Position.js';

export { PositionLot, InsufficientLotQuantityError } from './PositionLot.js';
export type { Side } from './PositionLot.js';

// Portfolio is exported from aggregates, not entities
// export { Portfolio, DuplicatePositionError, PositionNotFoundError } from './Portfolio.js';
export { DuplicatePositionError, PositionNotFoundError } from './Portfolio.js';

export { Orderbook } from './Orderbook.js';
export type { OrderbookLevel, OrderbookData } from './Orderbook.js';

export { Trade, TradeValidationError } from './Trade.js';
export type { TradeSide, TradeParams } from './Trade.js';
