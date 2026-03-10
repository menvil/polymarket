/**
 * Координатор проекторов.
 *
 * @remarks
 * Stub — используется PolymarketWsAdapter до рефакторинга Phase 0.5.
 * После Phase 0.5 этот класс будет удалён — логика перейдёт в Handlers.
 */
import type { ILogger } from '@polymarket/logger';
import type { InMemoryEventBus } from '../events/InMemoryEventBus.js';

/**
 * Минимальный stub координатора проекторов.
 */
export class ProjectorCoordinator {
  constructor(
    _eventBus: InMemoryEventBus,
    _logger: ILogger
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribeToOrderbook(_tokenId: string, _callback: (orderbook: any) => void): void {
    // stub
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribeToTrades(_tokenId: string, _callback: (trade: any) => void): void {
    // stub
  }

  unsubscribeAllOrderbooks(_tokenId: string): void {
    // stub
  }

  unsubscribeAllTrades(_tokenId: string): void {
    // stub
  }

  getOrderbookSubscriberCount(_tokenId: string): number {
    return 0;
  }

  getTradeSubscriberCount(_tokenId: string): number {
    return 0;
  }

  destroy(): void {
    // stub
  }
}
