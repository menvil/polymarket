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
 * Source: packages/application/orchestrators/src/index.ts
 * Commit: abe9354e07501e87bf8a90fa53cccf6fa1b206a4
 *
 * See README.md for what was preserved and what was extracted to docs/.
 */
/**
 * @polymarket/orchestrators — Слой оркестрации Application Layer.
 *
 * @remarks
 * Связывает IEventBus с use-cases.
 * Каждый оркестратор — единственный компонент с конкретной ответственностью:
 *
 * - `FillOrchestrator`: FILL_RECEIVED → ProcessFillUseCase
 * - `OrderUpdateOrchestrator`: ORDER_UPDATE_RECEIVED → UpdateOrderStatusUseCase
 *
 * ### Паттерн использования:
 * ```typescript
 * const fillOrch = new FillOrchestrator({
 *   eventBus,
 *   processFill,
 *   orderStateStore,
 *   portfolioService,
 *   logger,
 * });
 * fillOrch.register(); // при старте системы
 * // ...
 * fillOrch.unregister(); // при graceful shutdown
 * ```
 */
export { FillOrchestrator } from './FillOrchestrator.js';
/** Реэкспорт зависимостей {@link FillOrchestrator} (см. FillOrchestrator.ts). */
export type { FillOrchestratorDeps } from './FillOrchestrator.js';

export { OrderUpdateOrchestrator } from './OrderUpdateOrchestrator.js';
/** Реэкспорт зависимостей {@link OrderUpdateOrchestrator} (см. OrderUpdateOrchestrator.ts). */
export type { OrderUpdateOrchestratorDeps } from './OrderUpdateOrchestrator.js';
