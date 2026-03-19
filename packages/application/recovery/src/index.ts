/**
 * @polymarket/recovery — Сервисы восстановления и reconciliation.
 *
 * @remarks
 * Phase 9: запускается до WS-подписок для восстановления состояния системы.
 *
 * ### Содержимое:
 * - `PortfolioReplayService` — инициализация Portfolio из текущего баланса venue
 * - `OrderReconciler` — сверка локальных ордеров с venue (отмена закрытых)
 * - `ICurrentBalanceProvider` — порт: текущий USDC-баланс от venue
 * - `IVenueOrderProvider` — порт: ID открытых ордеров от venue
 *
 * ### Порядок запуска в системе:
 * ```typescript
 * // 1. Recovery (до WS подписок)
 * await portfolioReplayService.replay(accountId);
 * await orderReconciler.reconcile(accountId);
 *
 * // 2. Оркестраторы
 * fillOrchestrator.register();
 * riskOrchestrator.register();
 *
 * // 3. Стратегии
 * await strategyRunner.start(myStrategy);
 *
 * // 4. WS bridge (состояние готово)
 * marketDataFeedAdapter.start();
 * userEventFeedAdapter.start();
 * ```
 *
 * @example
 * ```typescript
 * import {
 *   PortfolioReplayService,
 *   OrderReconciler,
 *   type ICurrentBalanceProvider,
 *   type IVenueOrderProvider,
 * } from '@polymarket/recovery';
 * ```
 *
 * @packageDocumentation
 */
export { PortfolioReplayService } from './PortfolioReplayService.js';
export type { PortfolioReplayDeps } from './PortfolioReplayService.js';

export { OrderReconciler } from './OrderReconciler.js';
export type { OrderReconcilerDeps } from './OrderReconciler.js';

export type { ICurrentBalanceProvider } from './ICurrentBalanceProvider.js';
export type { IVenueOrderProvider } from './IVenueOrderProvider.js';

export { FillsReconciler } from './FillsReconciler.js';
export type {
  FillsReconcilerDeps,
  FillReconciliationReport,
  IVenueFillProcessor,
} from './FillsReconciler.js';

export { StateReconciliationService } from './StateReconciliationService.js';
export type {
  StateReconciliationDeps,
  StateReconciliationConfig,
} from './StateReconciliationService.js';
