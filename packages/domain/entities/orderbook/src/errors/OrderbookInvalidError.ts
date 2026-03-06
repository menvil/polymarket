/**
 * Re-export из '@polymarket/errors/orderbook'
 *
 * @remarks
 * OrderbookInvalidError перемещён в foundation/errors для переиспользования
 * другими пакетами. Этот файл оставлен как re-export для обратной совместимости
 * внутренних импортов пакета.
 */

export {
  OrderbookInvalidError,
  OrderbookInvalidReason,
  ORDERBOOK_INVALID_ERROR_CODE,
} from '@polymarket/errors/orderbook';
export type { OrderbookInvalidContext } from '@polymarket/errors/orderbook';
