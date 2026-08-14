/**
 * Событие полного исполнения заявки.
 *
 * @remarks
 * Несёт финальный fill + итоговую VWAP цену.
 * После этого события заявка переходит в терминальный статус FILLED.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003); metadata не
 * участвует в replay-семантике.
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { OrderId } from '@polymarket/ids';
import type { Price } from '@polymarket/value-objects';
import type { FillData } from '@polymarket/fill';

/** Payload события полного исполнения. */
export interface OrderFilledPayload {
  readonly orderId: OrderId;
  /** Последний fill */
  readonly fill: FillData;
  /** Итоговая VWAP */
  readonly averagePrice: Price;
}

export type OrderFilledEvent = MessageEnvelope<'ORDER_FILLED', OrderFilledPayload>;
