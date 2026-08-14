/**
 * Fills подтверждены on-chain (WsFillStatus: CONFIRMED).
 *
 * @remarks
 * Публикуется FillEventHandler при получении CONFIRMED для fills, ранее
 * опубликованных на MATCHED (early processing). Несёт финальность блокчейна.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003).
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { Fill } from '@polymarket/fill';
import type { Timestamp } from '@polymarket/timestamp';

export type FillConfirmedEvent = MessageEnvelope<
  'FILL_CONFIRMED',
  {
    /** Fills, подтверждённые on-chain */
    readonly fills: readonly Fill[];
    /** Timestamp получения CONFIRMED в системе */
    readonly receivedAt: Timestamp;
  }
>;
