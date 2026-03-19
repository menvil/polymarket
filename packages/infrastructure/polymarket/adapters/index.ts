/**
 * @polymarket/exchange/adapters — Bridge: Infrastructure → Application.
 *
 * @remarks
 * Phase 8: подключает реальный Polymarket клиент к application layer.
 *
 * ### Содержимое:
 * - `MarketDataFeedAdapter` — маршрутизация рыночных данных (WS → BookUpdateHandler)
 * - `UserEventFeedAdapter` — маршрутизация user-channel (WS → FillEventHandler, OrderUpdateHandler)
 * - `PolymarketExchangeClientAdapter` — реализует IExchangeClient через REST
 * - `PolymarketMarketDiscoveryAdapter` — реализует IMarketDiscoveryService через Gamma REST API
 *
 * ### Порядок запуска в системе:
 * ```typescript
 * // 1. Recovery (до WS подписок)
 * await portfolioReplay.replay(accountId);
 * await orderReconciler.reconcile(accountId);
 *
 * // 2. Оркестраторы
 * fillOrchestrator.register();
 * riskOrchestrator.register();
 *
 * // 3. Стратегии
 * await strategyRunner.start(myStrategy);
 *
 * // 4. WS bridge (теперь состояние готово)
 * marketDataFeedAdapter.start();
 * userEventFeedAdapter.start();
 * ```
 *
 * @example
 * ```typescript
 * import {
 *   MarketDataFeedAdapter,
 *   UserEventFeedAdapter,
 *   PolymarketExchangeClientAdapter,
 * } from '@polymarket/exchange/adapters';
 * ```
 *
 * @packageDocumentation
 */
export { MarketDataFeedAdapter } from './MarketDataFeedAdapter.js';
export { UserEventFeedAdapter } from './UserEventFeedAdapter.js';
export { PolymarketExchangeClientAdapter } from './PolymarketExchangeClientAdapter.js';
export { PolymarketMarketDiscoveryAdapter } from './PolymarketMarketDiscoveryAdapter.js';
export { PolymarketMarketDataRestClient } from '../rest/clients/PolymarketMarketDataRestClient.js';
