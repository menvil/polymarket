/**
 * PortfolioProjector - обновляет portfolio state при fill events
 */

import type { ILogger } from '../../domain/ports/ILogger.js';
import type { IEventBus } from '../../shared/events/IEventBus.js';
import type { OrderFilledEvent } from '../../domain/events/OrderFilledEvent.js';

export class PortfolioProjector {
  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: ILogger
  ) {}

  public start(): void {
    this.eventBus.subscribe('OrderFilled', (event) =>
      this.onOrderFilled(event as OrderFilledEvent)
    );

    this.logger.info('[PortfolioProjector] Started');
  }

  private onOrderFilled(event: OrderFilledEvent): void {
    // TODO: Update portfolio state (balance, positions) based on fill
    this.logger.debug(`[PortfolioProjector] Processing fill for ${event.order.id}`);
  }
}
