/**
 * Низкочастотное событие — полный стакан по запросу или раз в N ms.
 *
 * @remarks
 * Несёт сам `Orderbook` (`@polymarket/orderbook`) — иммутабельная entity,
 * безопасная для fanout-рассылки нескольким стратегиям без риска, что одна
 * увидит мутацию другой (в отличие от старого mutable `OrderBook`, ради
 * которого раньше строился отдельный `OrderBookSnapshot`-DTO).
 */
import type { Orderbook } from '@polymarket/orderbook';
import type { InstrumentId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';

export interface BookDepthEvent {
  readonly type: 'BOOK_DEPTH';
  /** ID токена (UP/DOWN outcome token) */
  readonly instrumentId: InstrumentId;
  /** Полный стакан — иммутабельная entity, не DTO */
  readonly snapshot: Orderbook;
  /** Timestamp снапшота */
  readonly timestamp: Timestamp;
}
