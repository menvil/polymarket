/**
 * Application-события жизненного цикла рынка.
 *
 * @remarks
 * `MarketOpenedEvent` — публикуется `OpenMarketUseCase` при открытии рынка.
 * `MarketClosedEvent` — публикуется `CloseMarketUseCase` при закрытии рынка.
 *
 * ### Подписчики:
 * - `StrategyRunner` — запускает/останавливает стратегию при MARKET_OPENED/MARKET_CLOSED
 * - `MarketDiscoveryPublisher` / `MarketExpiryMonitor` — обновляют внутреннее состояние
 */
export type { MarketCloseReason } from './MarketCloseReason.js';
export type { MarketOpenedEvent } from './MarketOpenedEvent.js';
export type { MarketClosedEvent } from './MarketClosedEvent.js';
