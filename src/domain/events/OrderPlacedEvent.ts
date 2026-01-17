/**
 * OrderPlacedEvent - событие успешного размещения ордера
 *
 * @remarks
 * Публикуется после успешного размещения ордера через CLOB API.
 * Lifecycle: PENDING → API call → OPEN → OrderPlacedEvent
 *
 * Используется для:
 * - Обновления OrderRepository (track order state)
 * - Logging и audit trail
 * - Metrics collection
 *
 * @example
 * ```typescript
 * const event = new OrderPlacedEvent(order);
 * eventBus.publish(event);
 *
 * // В projector:
 * eventBus.subscribe('OrderPlaced', (event: OrderPlacedEvent) => {
 *   orderRepository.save(event.order);
 *   logger.info(`Order placed: ${event.order.id}`);
 * });
 * ```
 */

import { DomainEvent } from './DomainEvent.js';
import type { Order } from '../entities/Order.js';

/**
 * OrderPlacedEvent class
 *
 * @remarks
 * Содержит полный Order entity после успешного размещения.
 */
export class OrderPlacedEvent extends DomainEvent {
  /**
   * Создаёт OrderPlacedEvent
   *
   * @param order - Размещённый ордер (с biржевым ID и статусом OPEN)
   * @param timestamp - Когда событие произошло (optional, default = now)
   *
   * @example
   * ```typescript
   * const placedOrder = await clobClient.placeOrder(...);
   * const event = new OrderPlacedEvent(placedOrder);
   * ```
   */
  constructor(
    public readonly order: Order,
    timestamp: Date = new Date()
  ) {
    super('OrderPlaced', timestamp);
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
      price: this.order.price.value,
      size: this.order.size.value,
      status: this.order.status,
    };
  }

  /**
   * String representation
   *
   * @returns Human-readable string
   */
  public override toString(): string {
    return `OrderPlacedEvent[${this.order.id}] ${this.order.side} ${this.order.size.value}@${this.order.price.value}`;
  }
}
