/**
 * Execution Events - события исполнения ордеров
 *
 * @remarks
 * События, описывающие изменения состояния ордеров в процессе исполнения.
 */
import type { TradeSide } from '../Trade.js';

/**
 * Событие принятия ордера биржей
 */
export interface OrderAccepted {
  type: 'OrderAccepted';
  orderId: string;
  side: TradeSide;
  marketId: string;
  price: number;
  size: number;
}

/**
 * Событие отмены ордера
 */
export interface OrderCancelled {
  type: 'OrderCancelled';
  orderId: string;
}

/**
 * Событие отклонения ордера
 */
export interface OrderRejected {
  type: 'OrderRejected';
  orderId: string;
  reason: string;
}

/**
 * Union type всех execution событий
 */
export type ExecutionEvent = OrderAccepted | OrderCancelled | OrderRejected;
