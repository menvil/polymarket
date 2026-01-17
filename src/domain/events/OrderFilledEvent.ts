/**
 * OrderFilledEvent - событие исполнения ордера
 *
 * @remarks
 * Публикуется когда ордер полностью или частично исполнен.
 * Обычно приходит через WebSocket (user events feed).
 *
 * Lifecycle: OPEN → match → FILLED/PARTIALLY_FILLED → OrderFilledEvent
 *
 * Используется для:
 * - Обновления OrderRepository (update filled size, status)
 * - Обновления Portfolio (update positions, balance)
 * - Logging и audit trail
 * - Metrics collection (fill rate, execution quality)
 *
 * @example
 * ```typescript
 * // Из WebSocket handler:
 * const event = new OrderFilledEvent(updatedOrder, fillSize, fillPrice);
 * eventBus.publish(event);
 *
 * // В projector:
 * eventBus.subscribe('OrderFilled', (event: OrderFilledEvent) => {
 *   portfolioProjector.updatePosition(event.order);
 *   metricsProjector.recordFill(event);
 * });
 * ```
 */

import { DomainEvent } from './DomainEvent.js';
import type { Order } from '../entities/Order.js';
import type { Quantity } from '../value-objects/Quantity.js';
import type { Price } from '../value-objects/Price.js';

/**
 * OrderFilledEvent class
 *
 * @remarks
 * Содержит обновлённый Order entity после fill + детали fill.
 */
export class OrderFilledEvent extends DomainEvent {
  /**
   * Создаёт OrderFilledEvent
   *
   * @param order - Обновлённый ордер (с updated filledSize)
   * @param fillSize - Размер текущего fill (может быть частичным)
   * @param fillPrice - Цена исполнения
   * @param timestamp - Когда событие произошло (optional, default = now)
   *
   * @example
   * ```typescript
   * // Полное исполнение:
   * const event = new OrderFilledEvent(order, order.size, Price.fromNumber(0.55));
   *
   * // Частичное исполнение:
   * const event = new OrderFilledEvent(order, Quantity.fromNumber(50), Price.fromNumber(0.55));
   * ```
   */
  constructor(
    public readonly order: Order,
    public readonly fillSize: Quantity,
    public readonly fillPrice: Price,
    timestamp: Date = new Date()
  ) {
    super('OrderFilled', timestamp);
  }

  /**
   * Проверяет, является ли fill полным
   *
   * @returns true если ордер полностью исполнен
   */
  public isFullyFilled(): boolean {
    return this.order.status === 'FILLED';
  }

  /**
   * Проверяет, является ли fill частичным
   *
   * @returns true если ордер частично исполнен
   */
  public isPartiallyFilled(): boolean {
    return this.order.isPartiallyFilled();
  }

  /**
   * Gets event-specific data for serialization
   *
   * @returns Event data
   */
  protected getData(): Record<string, unknown> {
    return {
      orderId: this.order.id,
      tokenId: this.order.tokenId,
      side: this.order.side,
      fillSize: this.fillSize.value,
      fillPrice: this.fillPrice.value,
      totalFilledSize: this.order.filledSize?.value || 0,
      totalSize: this.order.size.value,
      status: this.order.status,
      isFullyFilled: this.isFullyFilled(),
      isPartiallyFilled: this.isPartiallyFilled(),
    };
  }

  /**
   * String representation
   *
   * @returns Human-readable string
   */
  public override toString(): string {
    const fillType = this.isFullyFilled() ? 'FULL' : 'PARTIAL';
    return `OrderFilledEvent[${this.order.id}] ${fillType} fill: ${this.fillSize.value}@${this.fillPrice.value}`;
  }
}
