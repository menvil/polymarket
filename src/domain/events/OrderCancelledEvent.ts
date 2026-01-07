/**
 * OrderCancelledEvent - событие отмены ордера
 *
 * @remarks
 * Публикуется после отправки cancel request в CLOB API.
 * NOTE: Подтверждение отмены может прийти позже через WebSocket.
 *
 * Lifecycle: OPEN → cancelOrder() → cancel request sent → OrderCancelledEvent
 *
 * Используется для:
 * - Обновления OrderRepository (mark as cancellation pending)
 * - Logging и audit trail
 * - Metrics collection
 *
 * @example
 * ```typescript
 * await clobClient.cancelOrder({ orderId });
 * const event = new OrderCancelledEvent(orderId);
 * eventBus.publish(event);
 * ```
 */

import { DomainEvent } from './DomainEvent.js';

/**
 * OrderCancelledEvent class
 *
 * @remarks
 * Содержит orderId отменённого ордера.
 * Полное подтверждение отмены придёт через WebSocket (OrderUpdatedEvent).
 */
export class OrderCancelledEvent extends DomainEvent {
  /**
   * Создаёт OrderCancelledEvent
   *
   * @param orderId - ID отменённого ордера
   * @param reason - Причина отмены (optional)
   * @param timestamp - Когда событие произошло (optional, default = now)
   *
   * @example
   * ```typescript
   * const event = new OrderCancelledEvent('0x123abc', 'User requested');
   * ```
   */
  constructor(
    public readonly orderId: string,
    public readonly reason?: string,
    timestamp: Date = new Date()
  ) {
    super('OrderCancelled', timestamp);
  }

  /**
   * Gets event-specific data for serialization
   *
   * @returns Event data
   */
  protected getData(): Record<string, unknown> {
    return {
      orderId: this.orderId,
      reason: this.reason,
    };
  }

  /**
   * String representation
   *
   * @returns Human-readable string
   */
  public override toString(): string {
    return `OrderCancelledEvent[${this.orderId}]${this.reason ? ` (${this.reason})` : ''}`;
  }
}
