/**
 * Публичный трейд с ленты — маркет-принт.
 *
 * @remarks
 * Price и Quantity VOs: это application-layer событие, не wire DTO.
 * TradeReceivedEvent публикуется MarketDataFeedAdapter.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003): root-событие —
 * первичная реакция на внешнее WS-наблюдение.
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { InstrumentId } from '@polymarket/ids';
import type { Price, Quantity, Timestamp, Side } from '@polymarket/value-objects';

export type TradeReceivedEvent = MessageEnvelope<
  'TRADE_RECEIVED',
  {
    /** ID токена (UP/DOWN outcome token) */
    readonly instrumentId: InstrumentId;
    /** Цена трейда (VO, не string) */
    readonly price: Price;
    /** Объём трейда (VO, не string) */
    readonly size: Quantity;
    /** Сторона агрессора */
    readonly side: Side;
    /** Timestamp трейда */
    readonly timestamp: Timestamp;
  }
>;
