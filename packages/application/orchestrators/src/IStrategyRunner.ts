/**
 * IStrategyRunner — минимальный порт для взаимодействия с оркестраторами.
 *
 * @remarks
 * Полная реализация — в Phase 7 (@polymarket/strategy).
 * Определён здесь для развязки зависимости Phase 6 ↔ Phase 7 (mutual dependency).
 *
 * ### Принципы:
 * - RiskOrchestrator знает только IStrategyRunner, не конкретный StrategyRunner
 * - Phase 7 реализует этот интерфейс в классе StrategyRunner
 */
import type { RiskLimitBreachedEvent } from '@polymarket/event-bus';

/**
 * Порт для управления жизненным циклом стратегий.
 *
 * @remarks
 * Реализуется: StrategyRunner (Phase 7).
 * Потребляется: RiskOrchestrator.
 */
export interface IStrategyRunner {
  /**
   * Вызывается при нарушении риск-лимита.
   *
   * @param event - Событие нарушения риск-лимита
   *
   * @remarks
   * Если `event.strategyId` указан — останавливает конкретную стратегию.
   * Если `event.strategyId` undefined — системное нарушение, останавливает все стратегии.
   *
   * @example
   * ```typescript
   * eventBus.subscribe('RISK_LIMIT_BREACHED', async (event) => {
   *   await strategyRunner.onRiskBreached(event);
   * });
   * ```
   */
  onRiskBreached(event: RiskLimitBreachedEvent): Promise<void>;
}
