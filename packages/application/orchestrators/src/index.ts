/**
 * @polymarket/orchestrators — Слой оркестрации Application Layer.
 *
 * @remarks
 * Связывает IEventBus с use-cases и StrategyRunner.
 * Каждый оркестратор — единственный компонент с конкретной ответственностью:
 *
 * - `FillOrchestrator`: FILL_RECEIVED → ProcessFillUseCase
 * - `RiskOrchestrator`: RISK_LIMIT_BREACHED → IStrategyRunner.onRiskBreached()
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

export { RiskOrchestrator } from './RiskOrchestrator.js';
export type { RiskOrchestratorDeps } from './RiskOrchestrator.js';

export type { IStrategyRunner } from './IStrategyRunner.js';
