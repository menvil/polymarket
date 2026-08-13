/**
 * Событие отмены заявки (терминальный статус CANCELLED).
 */
import type { OrderId } from '@polymarket/ids';

export interface OrderCancelledEvent {
  readonly type: 'ORDER_CANCELLED';
  readonly orderId: OrderId;
  readonly reason: string;
}
