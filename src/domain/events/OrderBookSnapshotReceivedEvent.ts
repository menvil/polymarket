/**
 * OrderBookSnapshotReceivedEvent - событие получения snapshot ордербука
 *
 * @remarks
 * Событие возникает когда получен полный snapshot ордербука с WebSocket.
 *
 * Когда возникает:
 * - WebSocket отправил book message с полным состоянием bids/asks
 * - Первоначальная загрузка ордербука при подписке
 * - Периодические обновления состояния (не delta, а full snapshot)
 *
 * Зачем нужно:
 * - Обновление состояния market data агрегата
 * - Расчет spread и best bid/ask
 * - Валидация trade цен относительно текущего спреда
 * - Построение проекций для торговых стратегий
 *
 * @example
 * ```typescript
 * const event = new OrderBookSnapshotReceivedEvent(
 *   'token-123',
 *   [
 *     { price: 0.52, size: 100 },
 *     { price: 0.51, size: 200 }
 *   ],
 *   [
 *     { price: 0.53, size: 150 },
 *     { price: 0.54, size: 250 }
 *   ],
 *   new Date()
 * );
 *
 * console.log(event.assetId); // 'token-123'
 * console.log(event.bids.length); // 2
 * console.log(event.asks.length); // 2
 * ```
 */
import { DomainEvent } from './DomainEvent.js';

/**
 * Orderbook level (price and size)
 *
 * @remarks
 * Простой объект с ценой и размером.
 * НЕ использует value objects для упрощения сериализации и replay.
 */
export interface OrderbookLevel {
  /** Price as number */
  price: number;
  /** Size (quantity) as number */
  size: number;
}

/**
 * OrderBookSnapshotReceivedEvent
 *
 * @remarks
 * Иммутабельное событие, фиксирующее факт получения полного snapshot ордербука.
 * НЕ содержит value objects - только примитивы для упрощения event sourcing.
 */
export class OrderBookSnapshotReceivedEvent extends DomainEvent {
  /**
   * Creates OrderBookSnapshotReceivedEvent
   *
   * @param assetId - Asset/token ID
   * @param bids - Array of bid levels (sorted by price descending in source data)
   * @param asks - Array of ask levels (sorted by price ascending in source data)
   * @param timestamp - When snapshot was received (default: now)
   *
   * @remarks
   * Конструктор НЕ валидирует данные - это ответственность маппера.
   * Событие просто хранит данные как есть.
   *
   * bids/asks могут быть пустыми массивами (валидный случай - нет ликвидности).
   *
   * @example
   * ```typescript
   * // Normal orderbook
   * const event1 = new OrderBookSnapshotReceivedEvent(
   *   'token-123',
   *   [{ price: 0.52, size: 100 }],
   *   [{ price: 0.53, size: 150 }]
   * );
   *
   * // Empty orderbook (no liquidity)
   * const event2 = new OrderBookSnapshotReceivedEvent(
   *   'token-456',
   *   [],
   *   []
   * );
   * ```
   */
  constructor(
    public readonly assetId: string,
    public readonly bids: readonly OrderbookLevel[],
    public readonly asks: readonly OrderbookLevel[],
    timestamp: Date = new Date()
  ) {
    super('OrderBookSnapshotReceived', timestamp);
  }

  /**
   * Gets event data for serialization
   *
   * @returns Event data as plain object
   *
   * @remarks
   * Returns primitive data for JSON serialization and event sourcing.
   */
  protected getData(): Record<string, unknown> {
    return {
      assetId: this.assetId,
      bids: this.bids,
      asks: this.asks,
    };
  }

  /**
   * Gets best bid price
   *
   * @returns Best bid price or null if no bids
   *
   * @remarks
   * Assumes bids are sorted descending by price (best bid first).
   */
  public getBestBid(): number | null {
    return this.bids.length > 0 ? this.bids[0].price : null;
  }

  /**
   * Gets best ask price
   *
   * @returns Best ask price or null if no asks
   *
   * @remarks
   * Assumes asks are sorted ascending by price (best ask first).
   */
  public getBestAsk(): number | null {
    return this.asks.length > 0 ? this.asks[0].price : null;
  }

  /**
   * Calculates spread
   *
   * @returns Spread (ask - bid) or null if no bid/ask
   *
   * @example
   * ```typescript
   * const event = new OrderBookSnapshotReceivedEvent(
   *   'token-1',
   *   [{ price: 0.52, size: 100 }],
   *   [{ price: 0.53, size: 150 }]
   * );
   *
   * const spread = event.getSpread();
   * console.log(spread); // 0.01
   * ```
   */
  public getSpread(): number | null {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();
    if (bid === null || ask === null) return null;
    return ask - bid;
  }

  /**
   * String representation
   *
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * const event = new OrderBookSnapshotReceivedEvent(...);
   * console.log(event.toString());
   * // 'OrderBookSnapshotReceived[token-12...]: 2 bids, 2 asks, spread: 0.01'
   * ```
   */
  public toString(): string {
    const assetShort = this.assetId.substring(0, 10) + '...';
    const spread = this.getSpread();
    const spreadStr = spread !== null ? spread.toFixed(4) : 'N/A';
    return `OrderBookSnapshotReceived[${assetShort}]: ${this.bids.length} bids, ${this.asks.length} asks, spread: ${spreadStr}`;
  }
}
