/**
 * Событие закрытия рынка.
 *
 * @remarks
 * Публикуется после отмены всех ордеров и освобождения аллокации через `CloseMarketUseCase`.
 * `StrategyRunner` подписывается и останавливает стратегию.
 *
 * @example
 * ```typescript
 * eventBus.subscribe('MARKET_CLOSED', async (event) => {
 *   await strategyRunner.stop(event.marketId.toString());
 * });
 * ```
 */
import type { MarketId } from '@polymarket/ids';
import type { Money, Timestamp } from '@polymarket/value-objects';
import type { MarketCloseReason } from './MarketCloseReason.js';

export interface MarketClosedEvent {
  readonly type: 'MARKET_CLOSED';
  /** ID закрытого рынка */
  readonly marketId: MarketId;
  /** Причина закрытия */
  readonly reason: MarketCloseReason;
  /** Реализованный PnL за время торговли на рынке */
  readonly realizedPnL: Money;
  /** Метка времени закрытия */
  readonly timestamp: Timestamp;
}
