/**
 * Высокочастотное событие — каждое изменение лучшей цены стакана.
 *
 * @remarks
 * Несёт TopOfBook (immutable snapshot O(1)), а НЕ mutable OrderBook.
 * Стратегии подписываются через TradingAPI.subscribe('BOOK_UPDATED', cb).
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003): root-событие —
 * первичная реакция на внешнее WS-наблюдение.
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { MarketId, InstrumentId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';
import type { TopOfBook } from './TopOfBook.js';

export type BookUpdatedEvent = MessageEnvelope<
  'BOOK_UPDATED',
  {
    /** Верхушка стакана — лучшие bid/ask цены */
    readonly topOfBook: TopOfBook;
    /** ID токена (UP/DOWN outcome token) */
    readonly instrumentId: InstrumentId;
    /** ID рынка (condition_id) */
    readonly marketId: MarketId;
    /** Монотонно возрастающий номер снапшота — для gap detection */
    readonly sequenceNumber: number;
    /** Timestamp снапшота из Polymarket WS */
    readonly timestamp: Timestamp;
  }
>;
