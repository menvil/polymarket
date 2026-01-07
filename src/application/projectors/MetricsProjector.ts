/**
 * MetricsProjector - собирает метрики execution операций
 */

import type { ILogger } from '../../domain/ports/ILogger.js';
import type { IEventBus } from '../../shared/events/IEventBus.js';
import type { OrderPlacedEvent } from '../../domain/events/OrderPlacedEvent.js';
import type { OrderFilledEvent } from '../../domain/events/OrderFilledEvent.js';
import type { OrderRejectedEvent } from '../../domain/events/OrderRejectedEvent.js';

export class MetricsProjector {
  private ordersPlaced = 0;
  private ordersFilled = 0;
  private ordersRejected = 0;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: ILogger
  ) {}

  public start(): void {
    this.eventBus.subscribe('OrderPlaced', (event) =>
      this.onOrderPlaced(event as OrderPlacedEvent)
    );
    this.eventBus.subscribe('OrderFilled', (event) => this.onOrderFilled(event as OrderFilledEvent));
    this.eventBus.subscribe('OrderRejected', (event) =>
      this.onOrderRejected(event as OrderRejectedEvent)
    );

    this.logger.info('[MetricsProjector] Started');
  }

  private onOrderPlaced(_event: OrderPlacedEvent): void {
    this.ordersPlaced++;
    this.logger.silly(`[MetricsProjector] Orders placed: ${this.ordersPlaced}`);
  }

  private onOrderFilled(event: OrderFilledEvent): void {
    if (event.isFullyFilled()) {
      this.ordersFilled++;
      this.logger.silly(`[MetricsProjector] Orders filled: ${this.ordersFilled}`);
    }
  }

  private onOrderRejected(_event: OrderRejectedEvent): void {
    this.ordersRejected++;
    this.logger.silly(`[MetricsProjector] Orders rejected: ${this.ordersRejected}`);
  }

  public getMetrics(): {
    ordersPlaced: number;
    ordersFilled: number;
    ordersRejected: number;
    fillRate: number;
  } {
    return {
      ordersPlaced: this.ordersPlaced,
      ordersFilled: this.ordersFilled,
      ordersRejected: this.ordersRejected,
      fillRate: this.ordersPlaced > 0 ? this.ordersFilled / this.ordersPlaced : 0,
    };
  }
}
