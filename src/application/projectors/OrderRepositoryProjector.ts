/**
 * OrderRepositoryProjector - обновляет OrderRepository при execution событиях
 */

import type { ILogger } from '../../domain/ports/ILogger.js';
import type { IEventBus } from '../../shared/events/IEventBus.js';
import type { IOrderRepository } from '../../domain/ports/IOrderRepository.js';
import type { OrderPlacedEvent } from '../../domain/events/OrderPlacedEvent.js';
import type { OrderFilledEvent } from '../../domain/events/OrderFilledEvent.js';

export class OrderRepositoryProjector {
  constructor(
    private readonly eventBus: IEventBus,
    private readonly orderRepository: IOrderRepository,
    private readonly logger: ILogger
  ) {}

  public start(): void {
    this.eventBus.subscribe('OrderPlaced', (event) =>
      this.onOrderPlaced(event as OrderPlacedEvent)
    );
    this.eventBus.subscribe('OrderFilled', (event) => this.onOrderFilled(event as OrderFilledEvent));

    this.logger.info('[OrderRepositoryProjector] Started');
  }

  private onOrderPlaced(event: OrderPlacedEvent): void {
    this.orderRepository.save(event.order);
    this.logger.debug(`[OrderRepositoryProjector] Saved order: ${event.order.id}`);
  }

  private onOrderFilled(event: OrderFilledEvent): void {
    this.orderRepository.save(event.order);
    this.logger.debug(`[OrderRepositoryProjector] Updated order: ${event.order.id}`);
  }
}
