/*
 * LEGACY REFERENCE ONLY.
 *
 * Historical implementation of the trading contour, preserved for the
 * new trading runtime.
 *
 * Not built.
 * Not linted.
 * Not runnable against the current repository.
 * Do not import from production code.
 *
 * Source: packages/infrastructure/backtesting/src/index.ts
 * Commit: abe9354e07501e87bf8a90fa53cccf6fa1b206a4
 *
 * See README.md for what was preserved and what was extracted to docs/.
 */
/**
 * @polymarket/backtesting — движок воспроизведения рыночных данных для бектестирования.
 *
 * @remarks
 * Пакет позволяет воспроизводить записанные рыночные снапшоты через те же
 * application-layer хендлеры, которые используются при live-торговле.
 *
 * ### Содержимое пакета:
 * - `BacktestEngine` — главный оркестратор бектеста
 * - `MockExchangeClient` — симулятор биржевого клиента (реализует IExchangeClient)
 *
 * ### In-memory хранилища:
 * Re-export из `@polymarket/in-memory` для обратной совместимости.
 * Новый код должен импортировать напрямую из `@polymarket/in-memory`.
 *
 * ### Типы:
 * - `BacktestConfig` — конфигурация бектест-прогона
 * - `BacktestDeps` — зависимости BacktestEngine
 * - `BacktestResult` — результат выполнения бектеста
 * - `SubmittedOrder` — информация о поданном ордере (MockExchangeClient)
 *
 * @example
 * ```typescript
 * import { BacktestEngine, MockExchangeClient } from '@polymarket/backtesting';
 * import { InMemoryOrderRepository } from '@polymarket/in-memory';
 * ```
 */

export { BacktestEngine } from './BacktestEngine.js';
export type {
  BacktestConfig,
  BacktestDeps,
  BacktestResult,
  IBacktestCryptoMarketDataStore,
  IBacktestCryptoResolutionStore,
} from './BacktestEngine.js';

export { CrossMarketBacktestEngine } from './CrossMarketBacktestEngine.js';
export type {
  CrossMarketBacktestConfig,
  CrossMarketBacktestDeps,
  CrossMarketBacktestResult,
  ArbitrageOpportunity,
  PairResult,
  OpportunityWindow,
  SimulatedTrade,
  PairSimulationResult,
  SharedBalanceSimulationResult,
  SettlementInfo,
} from './CrossMarketBacktestEngine.js';

export { MockExchangeClient } from './MockExchangeClient.js';
export type { SubmittedOrder } from './MockExchangeClient.js';

// Re-export из @polymarket/in-memory для обратной совместимости.
// Новый код должен импортировать напрямую из @polymarket/in-memory.
export { InMemoryOrderRepository } from './InMemoryOrderRepository.js';
export { InMemoryPortfolioStore } from './InMemoryPortfolioStore.js';
export { InMemoryProcessedFillRepository } from './InMemoryProcessedFillRepository.js';
export { InMemoryReconciliationIssueRepository } from './InMemoryReconciliationIssueRepository.js';
export { InMemoryKeyedMutex } from './InMemoryKeyedMutex.js';
