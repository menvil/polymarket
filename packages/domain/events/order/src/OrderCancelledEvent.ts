/**
 * Событие отмены заявки (OPEN/PARTIALLY_FILLED → CANCELED).
 *
 * @remarks
 * Canonical envelope `{ type, payload, metadata }` (M-003); metadata не
 * участвует в replay-семантике.
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { OrderId } from '@polymarket/ids';

/** Payload события отмены заявки. */
export interface OrderCancelledPayload {
  readonly orderId: OrderId;
  readonly reason: string;
}

export type OrderCancelledEvent = MessageEnvelope<'ORDER_CANCELLED', OrderCancelledPayload>;
