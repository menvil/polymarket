/**
 * Событие подтверждения заявки биржей (PENDING → OPEN).
 *
 * @remarks
 * Canonical envelope `{ type, payload, metadata }` (M-003); metadata не
 * участвует в replay-семантике.
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { OrderId } from '@polymarket/ids';

/** Payload события подтверждения заявки. */
export interface OrderAcceptedPayload {
  readonly orderId: OrderId;
}

export type OrderAcceptedEvent = MessageEnvelope<'ORDER_ACCEPTED', OrderAcceptedPayload>;
