/**
 * Публичный трейд с ленты — маркет-принт.
 *
 * @remarks
 * Price и Quantity VOs: это application-layer событие, не wire DTO.
 * TradeReceivedEvent публикуется MarketDataFeedAdapter.
 */
import type { InstrumentId } from '@polymarket/ids';
import type { Price, Quantity, Timestamp, Side } from '@polymarket/value-objects';

export interface TradeReceivedEvent {
  readonly type: 'TRADE_RECEIVED';
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
