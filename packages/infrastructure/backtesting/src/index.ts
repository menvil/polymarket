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
