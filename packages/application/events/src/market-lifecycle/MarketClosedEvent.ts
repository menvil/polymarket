/**
 * Событие закрытия рынка.
 *
 * @remarks
 * Публикуется после отмены всех ордеров и освобождения аллокации через `CloseMarketUseCase`.
 * `StrategyRunner` подписывается и останавливает стратегию.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003).
 *
 * @example
 * ```typescript
 * eventBus.subscribe('MARKET_CLOSED', async (event) => {
 *   await strategyRunner.stop(event.payload.marketId.toString());
 * });
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { MarketId } from '@polymarket/ids';
import type { Money, Timestamp } from '@polymarket/value-objects';
import type { MarketCloseReason } from './MarketCloseReason.js';

export type MarketClosedEvent = MessageEnvelope<
  'MARKET_CLOSED',
  {
    /** ID закрытого рынка */
    readonly marketId: MarketId;
    /** Причина закрытия */
    readonly reason: MarketCloseReason;
    /** Реализованный PnL за время торговли на рынке */
    readonly realizedPnL: Money;
    /** Метка времени закрытия */
    readonly timestamp: Timestamp;
  }
>;
