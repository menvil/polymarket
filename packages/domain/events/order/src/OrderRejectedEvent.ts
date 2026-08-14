/**
 * Событие отклонения заявки биржей (PENDING → REJECTED).
 *
 * @remarks
 * Canonical envelope `{ type, payload, metadata }` (M-003); metadata не
 * участвует в replay-семантике.
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { OrderId, StrategyId } from '@polymarket/ids';

/** Payload события отклонения заявки. */
export interface OrderRejectedPayload {
  readonly orderId: OrderId;
  readonly reason: string;
  readonly strategyId?: StrategyId;
}

export type OrderRejectedEvent = MessageEnvelope<'ORDER_REJECTED', OrderRejectedPayload>;
