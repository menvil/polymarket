/**
 * @polymarket/coordinator — Оркестрация торговых стратегий.
 *
 * @remarks
 * ### Содержимое пакета:
 * - `StrategyCoordinator` — координатор обнаружения рынков и lifecycle стратегий
 * - `StrategyCoordinatorConfig` — конфигурация координатора
 * - `StrategyCoordinatorDeps` — зависимости координатора
 *
 * ### Принцип работы:
 * Координатор реагирует на `STRATEGY_TICK` события (без setInterval!) и:
 * - Каждые `discoverEveryNTicks` тиков: обнаруживает новые рынки
 * - Каждые `policyCheckEveryNTicks` тиков: проверяет политику удаления
 *
 * ### Интеграция:
 * ```typescript
 * const coordinator = new StrategyCoordinator(deps, config);
 * coordinator.start(totalBalance);
 *
 * // Внешний тикер публикует STRATEGY_TICK каждую секунду
 * let tick = 0;
 * setInterval(() => eventBus.publish({
 *   type: 'STRATEGY_TICK', tickNumber: tick++, timestamp,
 * }), 1000);
 * ```
 *
 * @packageDocumentation
 */

export { StrategyCoordinator } from './StrategyCoordinator.js';
export type {
  StrategyCoordinatorDeps,
} from './StrategyCoordinator.js';
export type { StrategyCoordinatorConfig } from './StrategyCoordinatorConfig.js';
