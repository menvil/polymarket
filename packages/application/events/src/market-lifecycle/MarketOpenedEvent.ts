/**
 * Событие открытия нового рынка.
 *
 * @remarks
 * Публикуется после успешной аллокации баланса через `OpenMarketUseCase`.
 * `StrategyRunner` подписывается и запускает стратегию для этого рынка.
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003).
 *
 * @example
 * ```typescript
 * eventBus.subscribe('MARKET_OPENED', async (event) => {
 *   await strategyRunner.start(new SimpleQuoter({ marketId: event.payload.marketId }));
 * });
 * ```
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { MarketId, StrategyId } from '@polymarket/ids';
import type { Money, Timestamp } from '@polymarket/value-objects';

export type MarketOpenedEvent = MessageEnvelope<
  'MARKET_OPENED',
  {
    /** ID открытого рынка */
    readonly marketId: MarketId;
    /** ID стратегии, которую нужно запустить для этого рынка — canonical branded `StrategyId` */
    readonly strategyId: StrategyId;
    /** Аллоцированный баланс для рынка в USDC */
    readonly allocatedBalance: Money;
    /** Метка времени открытия */
    readonly timestamp: Timestamp;
  }
>;
