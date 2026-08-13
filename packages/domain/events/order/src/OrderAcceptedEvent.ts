/**
 * Событие подтверждения заявки (переход в статус OPEN).
 */
import type { OrderId } from '@polymarket/ids';

export interface OrderAcceptedEvent {
  readonly type: 'ORDER_ACCEPTED';
  readonly orderId: OrderId;
}
