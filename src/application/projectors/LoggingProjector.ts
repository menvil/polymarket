/**
 * LoggingProjector - projector для логирования execution событий
 *
 * @remarks
 * Подписывается на все execution события и логирует их.
 * Используется для debugging и audit trail.
 */

import type { ILogger } from '../../domain/ports/ILogger.js';
import type { IEventBus } from '../../shared/events/IEventBus.js';
import type { OrderPlacedEvent } from '../../domain/events/OrderPlacedEvent.js';
import type { OrderCancelledEvent } from '../../domain/events/OrderCancelledEvent.js';
import type { OrderFilledEvent } from '../../domain/events/OrderFilledEvent.js';
import type { OrderRejectedEvent } from '../../domain/events/OrderRejectedEvent.js';
import type { OrderUpdatedEvent } from '../../domain/events/OrderUpdatedEvent.js';

export class LoggingProjector {
  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: ILogger
  ) {}

  public start(): void {
    this.eventBus.subscribe('OrderPlaced', (event) =>
      this.onOrderPlaced(event as OrderPlacedEvent)
    );
    this.eventBus.subscribe('OrderCancelled', (event) =>
      this.onOrderCancelled(event as OrderCancelledEvent)
    );
    this.eventBus.subscribe('OrderFilled', (event) => this.onOrderFilled(event as OrderFilledEvent));
    this.eventBus.subscribe('OrderRejected', (event) =>
      this.onOrderRejected(event as OrderRejectedEvent)
    );
    this.eventBus.subscribe('OrderUpdated', (event) =>
      this.onOrderUpdated(event as OrderUpdatedEvent)
    );

    this.logger.info('[LoggingProjector] Started');
  }

  private onOrderPlaced(event: OrderPlacedEvent): void {
    this.logger.info(
      `[OrderPlaced] ${event.order.id} - ${event.order.side} ${event.order.size.value}@${event.order.price.value}`
    );
  }

  private onOrderCancelled(event: OrderCancelledEvent): void {
    this.logger.info(`[OrderCancelled] ${event.orderId}${event.reason ? ' - ' + event.reason : ''}`);
  }

  private onOrderFilled(event: OrderFilledEvent): void {
    const fillType = event.isFullyFilled() ? 'FULL' : 'PARTIAL';
    this.logger.info(
      `[OrderFilled] ${event.order.id} - ${fillType} fill: ${event.fillSize.value}@${event.fillPrice.value}`
    );
  }

  private onOrderRejected(event: OrderRejectedEvent): void {
    this.logger.warn(`[OrderRejected] ${event.orderId} - ${event.reason}`);
  }

  private onOrderUpdated(event: OrderUpdatedEvent): void {
    this.logger.debug(
      `[OrderUpdated] ${event.order.id} - ${event.previousOrder?.status || 'NEW'} → ${event.order.status}`
    );
  }
}
