/**
 * Событие частичного исполнения заявки.
 *
 * @remarks
 * Canonical envelope `{ type, payload, metadata }` (M-003); metadata не
 * участвует в replay-семантике.
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { OrderId } from '@polymarket/ids';
import type { Quantity } from '@polymarket/value-objects';
import type { FillData } from '@polymarket/fill';

/** Payload события частичного исполнения. */
export interface OrderPartiallyFilledPayload {
  readonly orderId: OrderId;
  readonly fill: FillData;
  /** Накопленный объём после этого fill */
  readonly filledSize: Quantity;
  /** Остаток после этого fill */
  readonly remainingSize: Quantity;
}

export type OrderPartiallyFilledEvent = MessageEnvelope<'ORDER_PARTIALLY_FILLED', OrderPartiallyFilledPayload>;
