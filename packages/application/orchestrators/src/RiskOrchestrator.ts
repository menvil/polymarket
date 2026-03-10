/**
 * RiskOrchestrator — маршрутизирует RISK_LIMIT_BREACHED → IStrategyRunner.
 *
 * @remarks
 * Единственный компонент, связывающий риск-события со стратегиями.
 *
 * ### Почему нет MarketDataOrchestrator?
 * BOOK_UPDATED / BOOK_DEPTH — стратегии подписываются напрямую через
 * `ctx.api.subscribe()` (Phase 7 TradingAPI). Промежуточный оркестратор
 * создал бы publish-loop: infrastructure → EventBus → Orchestrator → EventBus.
 * Поэтому только risk-события маршрутизируются через RiskOrchestrator.
 *
 * ### Поведение при нарушении:
 * - `event.strategyId` указан → останавливает конкретную стратегию
 * - `event.strategyId` undefined → системное нарушение, останавливает всё
 *
 * @example
 * ```typescript
 * const orchestrator = new RiskOrchestrator(eventBus, strategyRunner, logger);
 * orchestrator.register();
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { IStrategyRunner } from './IStrategyRunner.js';

/**
 * Зависимости RiskOrchestrator.
 */
export interface RiskOrchestratorDeps {
  readonly eventBus: IEventBus;
  readonly strategyRunner: IStrategyRunner;
  readonly logger: ILogger;
}

/**
 * Оркестратор риск-событий.
 *
 * @remarks
 * Подписывается на RISK_LIMIT_BREACHED и делегирует IStrategyRunner.onRiskBreached().
 * Ошибки логируются, но не останавливают subscription loop.
 */
export class RiskOrchestrator {
  private readonly _eventBus: IEventBus;
  private readonly _strategyRunner: IStrategyRunner;
  private readonly _logger: ILogger;
  private _unsubscribe?: () => void;

  /**
   * @param deps - Зависимости оркестратора
   */
  constructor(deps: RiskOrchestratorDeps) {
    this._eventBus = deps.eventBus;
    this._strategyRunner = deps.strategyRunner;
    this._logger = deps.logger.child({ component: 'RiskOrchestrator' });
  }

  /**
   * Регистрирует подписку на RISK_LIMIT_BREACHED.
   *
   * @remarks
   * Идемпотентен — повторный вызов сначала отписывается от предыдущей подписки.
   *
   * @example
   * ```typescript
   * orchestrator.register();
   * // При shutdown:
   * orchestrator.unregister();
   * ```
   */
  public register(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
    }

    this._unsubscribe = this._eventBus.subscribe('RISK_LIMIT_BREACHED', async (event) => {
      this._logger.warn('Risk limit breached, notifying StrategyRunner', {
        violationType: event.violationType,
        violation: event.violation,
        strategyId: event.strategyId,
      });

      try {
        await this._strategyRunner.onRiskBreached(event);
      } catch (err) {
        this._logger.error('StrategyRunner.onRiskBreached failed', {
          err: err instanceof Error ? err : new Error(String(err)),
          violationType: event.violationType,
          strategyId: event.strategyId,
        });
      }
    });

    this._logger.info('RiskOrchestrator registered');
  }

  /**
   * Отписывается от RISK_LIMIT_BREACHED.
   *
   * @remarks
   * Вызывать при graceful shutdown.
   */
  public unregister(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._logger.debug('RiskOrchestrator unregistered');
  }
}
