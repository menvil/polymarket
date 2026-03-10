/**
 * Событие выполненного публичного трейда.
 *
 * @remarks
 * Stub — будет заменён в Phase 0.5 на подписку TradeTape через IPolymarketWsEmitter.
 */
import type { DomainEvent } from './DomainEvent.js';

/** Сторона сделки */
export type TradeSide = 'BUY' | 'SELL' | null;

/**
 * Событие публичного трейда.
 */
export class TradeExecutedEvent implements DomainEvent {
  readonly eventType = 'TradeExecuted';

  constructor(
    readonly assetId: string,
    readonly price: number,
    readonly size: number,
    readonly side: TradeSide,
    readonly timestamp: Date
  ) {}
}
