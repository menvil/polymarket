/**
 * Событие истечения срока действия заявки (терминальный статус EXPIRED).
 */
import type { OrderId } from '@polymarket/ids';

export interface OrderExpiredEvent {
  readonly type: 'ORDER_EXPIRED';
  readonly orderId: OrderId;
}
