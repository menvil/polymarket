/**
 * @polymarket/orchestrators — Слой оркестрации Application Layer.
 *
 * @remarks
 * Связывает IEventBus с use-cases и StrategyRunner.
 * Каждый оркестратор — единственный компонент с конкретной ответственностью:
 *
 * - `FillOrchestrator`: FILL_RECEIVED → ProcessFillUseCase
 * - `OrderUpdateOrchestrator`: ORDER_UPDATE_RECEIVED → UpdateOrderStatusUseCase
 *
 * ### Паттерн использования:
 * ```typescript
 * const fillOrch = new FillOrchestrator({ eventBus, processFill, logger });
 * fillOrch.register(); // при старте системы
 * // ...
 * fillOrch.unregister(); // при graceful shutdown
 * ```
 */
export { FillOrchestrator } from './FillOrchestrator.js';
export type { FillOrchestratorDeps } from './FillOrchestrator.js';

export { OrderUpdateOrchestrator } from './OrderUpdateOrchestrator.js';
export type { OrderUpdateOrchestratorDeps } from './OrderUpdateOrchestrator.js';
