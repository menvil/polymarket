/**
 * IStrategyRunner — полный интерфейс управления жизненным циклом стратегий.
 *
 * @remarks
 * Расширяет минимальный IStrategyRunner из @polymarket/orchestrators
 * методами `start`, `stop`, `stopAll`, `getMetrics`.
 *
 * ### Жизненный цикл стратегии:
 * ```
 * start(strategy) → initialize(ctx) → [подписки активны]
 *   ↓ (риск-лимит)
 * onRiskBreached(event) → stop(strategyId) → strategy.stop() + unsubscribeAll()
 * ```
 *
 * @example
 * ```typescript
 * const runner: IStrategyRunner = new StrategyRunner(deps);
 *
 * const result = await runner.start(myStrategy);
 * if (!result.ok) console.error('Strategy failed to start:', result.error.message);
 *
 * // Остановить конкретную стратегию:
 * await runner.stop('my-strategy-1');
 *
 * // Остановить все:
 * await runner.stopAll();
 * ```
 */
import type { Result } from '@polymarket/result';
import type { RiskLimitBreachedEvent } from '@polymarket/event-bus';
import type { IStrategy } from './IStrategy.js';

/**
 * Полный интерфейс управления стратегиями.
 *
 * @remarks
 * Реализуется: StrategyRunner (в этом пакете).
 * IStrategyRunner из @polymarket/orchestrators является подмножеством этого интерфейса.
 */
export interface IStrategyRunner {
  /**
   * Запускает стратегию.
   *
   * @param strategy - Стратегия для запуска
   * @returns Ok(void) при успехе, Err(Error) если initialize() вернул ошибку
   *
   * @remarks
   * Алгоритм:
   * 1. Создаёт изолированный TradingAPI для стратегии
   * 2. Вызывает `strategy.initialize(ctx)` с StrategyContext
   * 3. При Ok: добавляет стратегию в активные
   * 4. При Err: вызывает `tradingAPI.unsubscribeAll()` для cleanup и возвращает ошибку
   *
   * @example
   * ```typescript
   * const result = await runner.start(new SimpleQuoter());
   * if (!result.ok) logger.error('Failed to start', { error: result.error.message });
   * ```
   */
  start(strategy: IStrategy): Promise<Result<void, Error>>;

  /**
   * Останавливает стратегию по ID.
   *
   * @param strategyId - ID стратегии для остановки
   * @returns Promise, завершающийся после полной остановки
   *
   * @remarks
   * Алгоритм:
   * 1. Вызывает `strategy.stop()` (cleanup ресурсов самой стратегии)
   * 2. Вызывает `tradingAPI.unsubscribeAll()` (снятие всех подписок)
   * 3. Удаляет из `_strategies` и `_tradingAPIs`
   *
   * Если стратегия не найдена — logically no-op (предупреждение в лог).
   *
   * @example
   * ```typescript
   * await runner.stop('my-strategy-1');
   * ```
   */
  stop(strategyId: string): Promise<void>;

  /**
   * Останавливает все активные стратегии.
   *
   * @returns Promise, завершающийся после остановки всех стратегий
   *
   * @remarks
   * Используется при системном завершении или системном нарушении риска.
   * Все стратегии останавливаются параллельно (Promise.all).
   *
   * @example
   * ```typescript
   * await runner.stopAll();
   * ```
   */
  stopAll(): Promise<void>;

  /**
   * Возвращает текущие метрики стратегии.
   *
   * @param strategyId - ID стратегии
   * @returns Record с метриками или undefined если стратегия не найдена
   *
   * @remarks
   * Делегирует вызов `strategy.getMetrics()`.
   * Безопасен для частых вызовов (мониторинг).
   *
   * @example
   * ```typescript
   * const metrics = runner.getMetrics('my-strategy-1');
   * console.log(metrics?.ordersPlaced);
   * ```
   */
  getMetrics(strategyId: string): Record<string, unknown> | undefined;

  /**
   * Реагирует на нарушение риск-лимита.
   *
   * @param event - Событие нарушения
   *
   * @remarks
   * - Если `event.strategyId` указан → останавливает конкретную стратегию
   * - Если `event.strategyId` undefined → системное нарушение, останавливает все стратегии
   *
   * @example
   * ```typescript
   * // Вызывается автоматически RiskOrchestrator
   * await runner.onRiskBreached(event);
   * ```
   */
  onRiskBreached(event: RiskLimitBreachedEvent): Promise<void>;
}
