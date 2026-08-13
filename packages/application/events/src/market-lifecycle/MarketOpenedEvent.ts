/**
 * Событие открытия нового рынка.
 *
 * @remarks
 * Публикуется после успешной аллокации баланса через `OpenMarketUseCase`.
 * `StrategyRunner` подписывается и запускает стратегию для этого рынка.
 *
 * @example
 * ```typescript
 * eventBus.subscribe('MARKET_OPENED', async (event) => {
 *   await strategyRunner.start(new SimpleQuoter({ marketId: event.marketId }));
 * });
 * ```
 */
import type { MarketId, StrategyId } from '@polymarket/ids';
import type { Money, Timestamp } from '@polymarket/value-objects';

export interface MarketOpenedEvent {
  readonly type: 'MARKET_OPENED';
  /** ID открытого рынка */
  readonly marketId: MarketId;
  /** ID стратегии, которую нужно запустить для этого рынка — canonical branded `StrategyId` */
  readonly strategyId: StrategyId;
  /** Аллоцированный баланс для рынка в USDC */
  readonly allocatedBalance: Money;
  /** Метка времени открытия */
  readonly timestamp: Timestamp;
}
