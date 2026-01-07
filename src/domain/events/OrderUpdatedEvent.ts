/**
 * OrderUpdatedEvent - событие обновления ордера
 *
 * @remarks
 * Публикуется при любых изменениях ордера:
 * - Partial fills
 * - Status changes (OPEN → FILLED, OPEN → CANCELLED)
 * - Price/size adjustments
 *
 * Используется для централизованной обработки WebSocket updates.
 *
 * @example
 * ```typescript
 * // Из WebSocket handler:
 * const updatedOrder = OrderMapper.fromWebSocketUpdate(wsUpdate);
 * const event = new OrderUpdatedEvent(updatedOrder, previousOrder);
 * eventBus.publish(event);
 * ```
 */

import { DomainEvent } from './DomainEvent.js';
import type { Order } from '../entities/Order.js';

export class OrderUpdatedEvent extends DomainEvent {
  constructor(
    public readonly order: Order,
    public readonly previousOrder?: Order,
    timestamp: Date = new Date()
  ) {
    super('OrderUpdated', timestamp);
  }

  public hasStatusChanged(): boolean {
    return this.previousOrder !== undefined && this.previousOrder.status !== this.order.status;
  }

  public hasFilledSizeChanged(): boolean {
    const prevFilled = this.previousOrder?.filledSize?.value || 0;
    const currFilled = this.order.filledSize?.value || 0;
    return currFilled > prevFilled;
  }

  protected getData(): Record<string, unknown> {
    return {
      orderId: this.order.id,
      tokenId: this.order.tokenId,
      status: this.order.status,
      previousStatus: this.previousOrder?.status,
      filledSize: this.order.filledSize?.value || 0,
      previousFilledSize: this.previousOrder?.filledSize?.value || 0,
      hasStatusChanged: this.hasStatusChanged(),
      hasFilledSizeChanged: this.hasFilledSizeChanged(),
    };
  }

  public override toString(): string {
    return `OrderUpdatedEvent[${this.order.id}] ${this.previousOrder?.status || 'NEW'} → ${this.order.status}`;
  }
}
