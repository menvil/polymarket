/**
 * Событие получения снапшота стакана.
 *
 * @remarks
 * Stub — будет заменён в Phase 0.5 на BookUpdateHandler.handleFullState().
 */
import type { DomainEvent } from './DomainEvent.js';

/** Уровень стакана */
export interface PriceLevel {
  price: number;
  size: number;
}

/**
 * Событие снапшота стакана.
 */
export class OrderBookSnapshotReceivedEvent implements DomainEvent {
  readonly eventType = 'OrderBookSnapshotReceived';

  constructor(
    readonly assetId: string,
    readonly bids: PriceLevel[],
    readonly asks: PriceLevel[],
    readonly timestamp: Date
  ) {}
}
