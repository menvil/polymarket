/**
 * PositionChangedEvent - событие изменения позиции
 *
 * @remarks
 * Событие возникает при изменении позиции в портфеле.
 *
 * Когда возникает:
 * - После исполнения ордера (buy/sell)
 * - При закрытии позиции
 * - При добавлении/удалении лотов
 *
 * Зачем нужно:
 * - Трекинг изменений позиций
 * - Расчет P&L (realized и unrealized)
 * - Риск-менеджмент (position limits)
 * - Уведомления о значительных изменениях
 *
 * @example
 * ```typescript
 * const event = new PositionChangedEvent(
 *   'position-market-YES',
 *   Quantity.fromNumber(50),      // +50 shares
 *   Quantity.fromNumber(150),     // new total: 150
 *   Money.fromUSDC(25),            // unrealized P&L: +$25
 *   new Date()
 * );
 * ```
 */
import { DomainEvent } from './DomainEvent.js';
import { Quantity } from '../value-objects/Quantity.js';
import { Money } from '../value-objects/Money.js';

/**
 * PositionChangedEvent
 *
 * @remarks
 * Иммутабельное событие, фиксирующее изменение позиции.
 */
export class PositionChangedEvent extends DomainEvent {
  /**
   * Creates PositionChangedEvent
   *
   * @param positionId - ID позиции (обычно tokenId)
   * @param deltaQuantity - Изменение количества (signed: + = buy, - = sell)
   * @param newQuantity - Новое общее количество
   * @param unrealizedPnl - Текущий unrealized P&L
   * @param timestamp - Время изменения (default: now)
   *
   * @example
   * ```typescript
   * // BUY: добавили 50 shares
   * const event1 = new PositionChangedEvent(
   *   'market-YES',
   *   Quantity.fromNumber(50),     // delta: +50
   *   Quantity.fromNumber(150),    // new total: 150
   *   Money.fromUSDC(15)           // unrealized: +$15
   * );
   *
   * // SELL: продали 30 shares
   * const event2 = new PositionChangedEvent(
   *   'market-YES',
   *   Quantity.fromNumber(-30),    // delta: -30
   *   Quantity.fromNumber(120),    // new total: 120
   *   Money.fromUSDC(10)           // unrealized: +$10
   * );
   *
   * // CLOSED: закрыли позицию полностью
   * const event3 = new PositionChangedEvent(
   *   'market-YES',
   *   Quantity.fromNumber(-120),   // delta: -120
   *   Quantity.fromNumber(0),      // new total: 0
   *   Money.fromUSDC(0)            // unrealized: 0
   * );
   * ```
   */
  constructor(
    public readonly positionId: string,
    public readonly deltaQuantity: Quantity,
    public readonly newQuantity: Quantity,
    public readonly unrealizedPnl: Money,
    timestamp: Date = new Date()
  ) {
    super('PositionChanged', timestamp);
  }

  /**
   * Gets event data for serialization
   *
   * @returns Event data
   */
  protected getData(): Record<string, unknown> {
    return {
      positionId: this.positionId,
      deltaQuantity: this.deltaQuantity.value,
      newQuantity: this.newQuantity.value,
      unrealizedPnl: this.unrealizedPnl.amount,
    };
  }

  /**
   * Checks if position increased
   *
   * @returns True if delta > 0 (buy)
   *
   * @example
   * ```typescript
   * const event = new PositionChangedEvent(..., Quantity.fromNumber(50), ...);
   * console.log(event.isIncrease()); // true
   * ```
   */
  public isIncrease(): boolean {
    return this.deltaQuantity.value > 0;
  }

  /**
   * Checks if position decreased
   *
   * @returns True if delta < 0 (sell)
   *
   * @example
   * ```typescript
   * const event = new PositionChangedEvent(..., Quantity.fromNumber(-30), ...);
   * console.log(event.isDecrease()); // true
   * ```
   */
  public isDecrease(): boolean {
    return this.deltaQuantity.value < 0;
  }

  /**
   * Checks if position closed
   *
   * @returns True if newQuantity = 0
   *
   * @example
   * ```typescript
   * const event = new PositionChangedEvent(..., Quantity.fromNumber(0), ...);
   * console.log(event.isClosed()); // true
   * ```
   */
  public isClosed(): boolean {
    return this.newQuantity.value === 0;
  }

  /**
   * String representation
   *
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * const event = new PositionChangedEvent(...);
   * console.log(event.toString());
   * // 'PositionChanged[market-YES]: +50 → 150 (unrealized: +$25.00)'
   * ```
   */
  public toString(): string {
    const delta = this.deltaQuantity.value >= 0 ? `+${this.deltaQuantity.value}` : this.deltaQuantity.value;
    const pnl = this.unrealizedPnl.amount >= 0 ? `+$${this.unrealizedPnl.amount.toFixed(2)}` : `-$${Math.abs(this.unrealizedPnl.amount).toFixed(2)}`;
    return `PositionChanged[${this.positionId}]: ${delta} → ${this.newQuantity.value} (unrealized: ${pnl})`;
  }
}
