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
 * - `InMemoryProcessedFillRepository` — idempotency guard для Fill (реализует IProcessedFillRepository)
 *
 * @example
 * ```typescript
 * import {
 *   InMemoryOrderRepository,
 *   InMemoryPortfolioStore,
 *   InMemoryProcessedFillRepository,
 * } from '@polymarket/in-memory';
 *
 * const orderRepo = new InMemoryOrderRepository();
 * const portfolioStore = new InMemoryPortfolioStore();
 * const processedFillRepo = new InMemoryProcessedFillRepository();
 * ```
 */

export { InMemoryOrderRepository } from './InMemoryOrderRepository.js';
export { InMemoryPortfolioStore } from './InMemoryPortfolioStore.js';
export { InMemoryProcessedFillRepository } from './InMemoryProcessedFillRepository.js';
