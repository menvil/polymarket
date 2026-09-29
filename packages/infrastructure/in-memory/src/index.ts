/**
 * @polymarket/in-memory — in-memory реализации портов (IOrderRepository, IPortfolioStore, IProcessedFillRepository).
 *
 * @remarks
 * General-purpose in-memory хранилища, используемые во всех режимах бота:
 * paper, backtest, live (до перехода на Redis/PostgreSQL).
 *
 * ### Содержимое пакета:
 * - `InMemoryOrderRepository` — хранилище ордеров (реализует IOrderRepository + IOrderStateStore)
 * - `InMemoryPortfolioStore` — CAS-хранилище Portfolio (реализует IPortfolioStore)
 * - `InMemoryProcessedFillRepository` — idempotency + lifecycle guard для Fill (реализует IProcessedFillRepository)
 * - `InMemoryReconciliationIssueRepository` — queryable хранилище reconciliation issues (реализует IReconciliationIssueRepository)
 * - `InMemoryKeyedMutex` — keyed mutex для сериализации fill/cancel (реализует IKeyedMutex)
 *
 * @example
 * ```typescript
 * import {
 *   InMemoryOrderRepository,
 *   InMemoryPortfolioStore,
 *   InMemoryProcessedFillRepository,
 *   InMemoryKeyedMutex,
 * } from '@polymarket/in-memory';
 *
 * const orderRepo = new InMemoryOrderRepository();
 * const portfolioStore = new InMemoryPortfolioStore();
 * const processedFillRepo = new InMemoryProcessedFillRepository();
 * const keyedMutex = new InMemoryKeyedMutex();
 * ```
 */

export { InMemoryOrderRepository } from './InMemoryOrderRepository.js';
export { InMemoryPortfolioStore } from './InMemoryPortfolioStore.js';
export { InMemoryProcessedFillRepository } from './InMemoryProcessedFillRepository.js';
export { InMemoryReconciliationIssueRepository } from './InMemoryReconciliationIssueRepository.js';
export { InMemoryOrderSubmissionRepository } from './InMemoryOrderSubmissionRepository.js';
export { InMemoryKeyedMutex } from './InMemoryKeyedMutex.js';
