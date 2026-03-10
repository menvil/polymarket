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
 * - `InMemoryOrderRepository` — хранилище ордеров в памяти (реализует IOrderRepository)
 * - `InMemoryPortfolioStore` — CAS-хранилище Portfolio в памяти (реализует IPortfolioStore)
 * - `InMemoryProcessedFillRepository` — idempotency guard в памяти (реализует IProcessedFillRepository)
 *
 * ### Типы:
 * - `BacktestConfig` — конфигурация бектест-прогона
 * - `BacktestDeps` — зависимости BacktestEngine
 * - `BacktestResult` — результат выполнения бектеста
 * - `SubmittedOrder` — информация о поданном ордере (MockExchangeClient)
 *
 * @example
 * ```typescript
 * import {
 *   BacktestEngine,
 *   MockExchangeClient,
 *   InMemoryOrderRepository,
 *   InMemoryPortfolioStore,
 *   InMemoryProcessedFillRepository,
 * } from '@polymarket/backtesting';
 *
 * const engine = new BacktestEngine(
 *   {
 *     snapshotDir: './data/snapshots',
 *     fromDate: '2026-01-01',
 *     toDate: '2026-01-07',
 *     marketId: '0xabc',
 *   },
 *   {
 *     bookUpdateHandler: handler,
 *     logger,
 *   },
 * );
 *
 * const result = await engine.run();
 * console.log(`Processed ${result.processedEvents} events in ${result.durationMs}ms`);
 * ```
 */

export { BacktestEngine } from './BacktestEngine.js';
export type { BacktestConfig, BacktestDeps, BacktestResult } from './BacktestEngine.js';

export { MockExchangeClient } from './MockExchangeClient.js';
export type { SubmittedOrder } from './MockExchangeClient.js';

export { InMemoryOrderRepository } from './InMemoryOrderRepository.js';
export { InMemoryPortfolioStore } from './InMemoryPortfolioStore.js';
export { InMemoryProcessedFillRepository } from './InMemoryProcessedFillRepository.js';
