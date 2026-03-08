/**
 * @polymarket/errors/orderbook - ошибки Orderbook entity
 *
 * @remarks
 * Sub-path экспорт для ошибок, связанных с Orderbook.
 *
 * @example
 * ```typescript
 * import { OrderbookValidationError } from '@polymarket/errors/orderbook';
 * ```
 */

export { OrderbookValidationError } from './OrderbookValidationError.js';
export {
  OrderbookInvalidError,
  OrderbookInvalidReason,
  ORDERBOOK_INVALID_ERROR_CODE,
} from './OrderbookInvalidError.js';
export type { OrderbookInvalidContext } from './OrderbookInvalidError.js';
