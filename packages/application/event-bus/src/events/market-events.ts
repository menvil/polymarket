/**
 * Рыночные события — обновления стакана и трейды.
 *
 * @remarks
 * BookUpdatedEvent — высокочастотное событие (каждый снапшот стакана).
 * Несёт TopOfBook (immutable snapshot O(1)), а НЕ mutable OrderBook —
 * потому что несколько стратегий получают это событие через fanout.
 * Если передать mutable OrderBook, стратегия А увидит изменения стратегии Б.
 */
import type { Orderbook } from '@polymarket/orderbook';
import type { MarketId, InstrumentId } from '@polymarket/ids';
import type { Price, Quantity, Timestamp, Side } from '@polymarket/value-objects';

/**
 * Верхушка стакана — immutable snapshot лучших цен.
 *
 * @remarks
 * Создаётся BookUpdateHandler при каждом снапшоте. O(1) — только лучшие уровни.
 */
export interface TopOfBook {
  /** Лучшая цена bid (или undefined если стакан пуст) */
  readonly bestBid: Price | undefined;
  /** Лучшая цена ask (или undefined если стакан пуст) */
  readonly bestAsk: Price | undefined;
  /** Spread = bestAsk - bestBid (или undefined) */
  readonly spread: Price | undefined;
  /** Размер лучшего bid (или undefined) */
  readonly bestBidSize: Quantity | undefined;
  /** Размер лучшего ask (или undefined) */
  readonly bestAskSize: Quantity | undefined;
}

/**
 * Высокочастотное событие — каждое изменение лучшей цены стакана.
 *
 * @remarks
 * Несёт TopOfBook (immutable snapshot O(1)), а НЕ mutable OrderBook.
 * Стратегии подписываются через TradingAPI.subscribe('BOOK_UPDATED', cb).
 */
export interface BookUpdatedEvent {
  readonly type: 'BOOK_UPDATED';
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

/**
 * Низкочастотное событие — полный стакан по запросу или раз в N ms.
 *
 * @remarks
 * Несёт сам `Orderbook` (`@polymarket/orderbook`) — иммутабельная entity,
 * безопасная для fanout-рассылки нескольким стратегиям без риска, что одна
 * увидит мутацию другой (в отличие от старого mutable `OrderBook`, ради
 * которого раньше строился отдельный `OrderBookSnapshot`-DTO).
 */
export interface BookDepthEvent {
  readonly type: 'BOOK_DEPTH';
  /** ID токена (UP/DOWN outcome token) */
  readonly instrumentId: InstrumentId;
  /** Полный стакан — иммутабельная entity, не DTO */
  readonly snapshot: Orderbook;
  /** Timestamp снапшота */
  readonly timestamp: Timestamp;
}

/**
 * Публичный трейд с ленты — маркет-принт.
 *
 * @remarks
 * Price и Quantity VOs: это application-layer событие, не wire DTO.
 * TradeReceivedEvent публикуется MarketDataFeedAdapter.
 */
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
