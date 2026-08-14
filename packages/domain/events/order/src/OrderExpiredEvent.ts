/**
 * Событие истечения заявки по TTL (OPEN/PARTIALLY_FILLED → EXPIRED).
 *
 * @remarks
 * Canonical envelope `{ type, payload, metadata }` (M-003); metadata не
 * участвует в replay-семантике.
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { OrderId } from '@polymarket/ids';

/** Payload события истечения заявки. */
export interface OrderExpiredPayload {
  readonly orderId: OrderId;
}

export type OrderExpiredEvent = MessageEnvelope<'ORDER_EXPIRED', OrderExpiredPayload>;
