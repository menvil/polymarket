/**
 * TradeExecutedEvent - событие исполнения сделки на рынке
 *
 * @remarks
 * Событие возникает когда на рынке произошла сделка (trade).
 *
 * Когда возникает:
 * - WebSocket отправил trade message
 * - WebSocket отправил last_trade_price message (без side)
 * - Кто-то купил или продал shares на рынке
 *
 * Зачем нужно:
 * - Обновление last trade price в агрегате
 * - Валидация цены относительно текущего ордербука
 * - Расчет market momentum и volume
 * - Построение candlestick графиков
 * - Аудит рыночной активности
 *
 * @example
 * ```typescript
 * // Trade with side (BUY)
 * const event1 = new TradeExecutedEvent(
 *   'token-123',
 *   0.52,
 *   50,
 *   'BUY',
 *   new Date()
 * );
 *
 * // Last trade price (no side)
 * const event2 = new TradeExecutedEvent(
 *   'token-456',
 *   0.65,
 *   75,
 *   null
 * );
 *
 * console.log(event1.price); // 0.52
 * console.log(event1.size); // 50
 * console.log(event1.side); // 'BUY'
 * console.log(event2.side); // null
 * ```
 */
import { DomainEvent } from './DomainEvent.js';

/**
 * Trade side
 *
 * @remarks
 * - 'BUY': Покупка (taker купил)
 * - 'SELL': Продажа (taker продал)
 * - null: Сторона неизвестна (для last_trade_price)
 */
export type TradeSide = 'BUY' | 'SELL' | null;

/**
 * TradeExecutedEvent
 *
 * @remarks
 * Иммутабельное событие, фиксирующее факт исполнения сделки на рынке.
 * НЕ содержит value objects - только примитивы для упрощения event sourcing.
 */
export class TradeExecutedEvent extends DomainEvent {
  /**
   * Creates TradeExecutedEvent
   *
   * @param assetId - Asset/token ID
   * @param price - Trade price as number
   * @param size - Trade size (quantity) as number
   * @param side - Trade side ('BUY' | 'SELL' | null)
   * @param timestamp - When trade occurred (default: now)
   *
   * @remarks
   * Конструктор НЕ валидирует данные - это ответственность маппера.
   * Событие просто хранит данные как есть.
   *
   * side может быть null для last_trade_price messages.
   *
   * @example
   * ```typescript
   * // Normal trade with side
   * const event1 = new TradeExecutedEvent(
   *   'token-123',
   *   0.52,
   *   50,
   *   'BUY'
   * );
   *
   * // Last trade price (no side)
   * const event2 = new TradeExecutedEvent(
   *   'token-456',
   *   0.65,
   *   75,
   *   null
   * );
   * ```
   */
  constructor(
    public readonly assetId: string,
    public readonly price: number,
    public readonly size: number,
    public readonly side: TradeSide,
    timestamp: Date = new Date()
  ) {
    super('TradeExecuted', timestamp);
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
      price: this.price,
      size: this.size,
      side: this.side,
    };
  }

  /**
   * Calculates notional value of trade
   *
   * @returns Notional value (price * size)
   *
   * @remarks
   * notional = price * size
   *
   * @example
   * ```typescript
   * const event = new TradeExecutedEvent(
   *   'token-1',
   *   0.65,
   *   100,
   *   'BUY'
   * );
   *
   * const notional = event.getNotional();
   * console.log(notional); // 65
   * ```
   */
  public getNotional(): number {
    return this.price * this.size;
  }

  /**
   * Checks if trade is a buy
   *
   * @returns True if side is 'BUY', false otherwise
   *
   * @example
   * ```typescript
   * const buyTrade = new TradeExecutedEvent('token-1', 0.5, 10, 'BUY');
   * const sellTrade = new TradeExecutedEvent('token-2', 0.5, 10, 'SELL');
   * const unknownTrade = new TradeExecutedEvent('token-3', 0.5, 10, null);
   *
   * console.log(buyTrade.isBuy()); // true
   * console.log(sellTrade.isBuy()); // false
   * console.log(unknownTrade.isBuy()); // false
   * ```
   */
  public isBuy(): boolean {
    return this.side === 'BUY';
  }

  /**
   * Checks if trade is a sell
   *
   * @returns True if side is 'SELL', false otherwise
   *
   * @example
   * ```typescript
   * const buyTrade = new TradeExecutedEvent('token-1', 0.5, 10, 'BUY');
   * const sellTrade = new TradeExecutedEvent('token-2', 0.5, 10, 'SELL');
   * const unknownTrade = new TradeExecutedEvent('token-3', 0.5, 10, null);
   *
   * console.log(buyTrade.isSell()); // false
   * console.log(sellTrade.isSell()); // true
   * console.log(unknownTrade.isSell()); // false
   * ```
   */
  public isSell(): boolean {
    return this.side === 'SELL';
  }

  /**
   * String representation
   *
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * const event = new TradeExecutedEvent(...);
   * console.log(event.toString());
   * // 'TradeExecuted[token-12...]: BUY 50 @ 0.52 (notional: 26.00)'
   * ```
   */
  public toString(): string {
    const assetShort = this.assetId.length > 10
      ? this.assetId.substring(0, 10) + '...'
      : this.assetId;
    const sideStr = this.side || 'UNKNOWN';
    return `TradeExecuted[${assetShort}]: ${sideStr} ${this.size} @ ${this.price} (notional: ${this.getNotional().toFixed(2)})`;
  }
}
