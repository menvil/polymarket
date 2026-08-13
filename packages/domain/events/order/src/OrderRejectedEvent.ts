/**
 * Событие отклонения заявки до исполнения (терминальный статус REJECTED).
 */
import type { OrderId, StrategyId } from '@polymarket/ids';

export interface OrderRejectedEvent {
  readonly type: 'ORDER_REJECTED';
  readonly orderId: OrderId;
  readonly reason: string;
  readonly strategyId?: StrategyId;
}
