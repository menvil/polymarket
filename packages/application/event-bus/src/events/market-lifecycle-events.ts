/**
 * События жизненного цикла рынка.
 *
 * @remarks
 * `MarketOpenedEvent` — публикуется `OpenMarketUseCase` при открытии рынка.
 * `MarketClosedEvent` — публикуется `CloseMarketUseCase` при закрытии рынка.
 *
 * ### Подписчики:
 * - `StrategyRunner` — запускает/останавливает стратегию при MARKET_OPENED/MARKET_CLOSED
 * - `MarketDiscoveryPublisher` / `MarketExpiryMonitor` — обновляют внутреннее состояние
 */
import type { MarketId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';
import type { Money } from '@polymarket/value-objects';

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
export interface MarketOpenedEvent {
  readonly type: 'MARKET_OPENED';
  /** ID открытого рынка */
  readonly marketId: MarketId;
  /** ID стратегии, которую нужно запустить для этого рынка */
  readonly strategyId: string;
  /** Аллоцированный баланс для рынка в USDC */
  readonly allocatedBalance: Money;
  /** Метка времени открытия */
  readonly timestamp: Timestamp;
}

/**
 * Причина закрытия рынка.
 *
 * @remarks
 * - `EXPIRED` — рынок истёк (ExpirationRemovalPolicy)
 * - `MANUAL` — ручная остановка оператором
 * - `POLICY` — другая policy (RiskPolicy, MarketQualityPolicy и т.п.)
 */
export type MarketCloseReason = 'EXPIRED' | 'MANUAL' | 'POLICY';

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
