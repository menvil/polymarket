/**
 * IStrategyRunner - контракт lifecycle менеджера стратегии
 *
 * @remarks
 * КРИТИЧНО v2: Runner = lifecycle + wiring, NO логики!
 *
 * Runner responsibilities:
 * - Lifecycle management (start/stop)
 * - Wiring (подписка на EventBus, создание ctx)
 * - Таймер для onTick
 * - Связывает стратегию с infrastructure
 *
 * Runner НЕ должен:
 * - Знать про state стратегии
 * - Принимать решений (кроме "stop на FSM violation")
 * - Модифицировать intents
 * - Фильтровать events
 * - Читать strategy.state
 *
 * v4 changes:
 * - Публикует LifecycleEvent: StrategyStarted ПОСЛЕ onStart()
 * - Подписывается на ExecutionEvent И LifecycleEvent
 * - Ловит FSM violations в onExecutionEvent → stop()
 *
 * Жёсткое правило v2:
 * Если Runner знает про state → ты восстановил Orchestrator.
 * Runner = просто запускает/останавливает стратегию.
 *
 * @example
 * ```typescript
 * class StrategyRunner implements IStrategyRunner {
 *   start(): void {
 *     // 1. Call strategy.onStart()
 *     const intents = this.strategy.onStart(this.ctx);
 *     this.executor.execute(intents, this.ctx);
 *
 *     // 2. Subscribe to EventBus
 *     this.eventBus.subscribe('OrderAccepted', this.onExecutionEvent);
 *     this.eventBus.subscribe('StrategyStarted', this.onExecutionEvent);
 *
 *     // 3. Start tick timer
 *     this.tickIntervalId = setInterval(() => this.onTick(), 1000);
 *
 *     // 4. v4: Publish LifecycleEvent: StrategyStarted
 *     this.eventBus.publish('StrategyStarted', {
 *       type: 'StrategyStarted',
 *       strategyId: this.strategy.id,
 *       timestamp: this.ctx.now(),
 *     });
 *   }
 *
 *   stop(): void {
 *     // 1. Stop timer
 *     clearInterval(this.tickIntervalId);
 *
 *     // 2. Unsubscribe from EventBus
 *     for (const unsub of this.unsubscribeFunctions) {
 *       unsub();
 *     }
 *
 *     // 3. Call strategy.onStop()
 *     this.strategy.onStop();
 *   }
 * }
 *
 * // ❌ НЕПРАВИЛЬНО (Runner знает про state):
 * class BadRunner implements IStrategyRunner {
 *   start(): void {
 *     // ...
 *   }
 *
 *   private onExecutionEvent(event: ExecutionEvent): void {
 *     // ❌ Runner читает state
 *     if (this.strategy.state === 'STOPPED') {
 *       return; // ❌ принятие решений
 *     }
 *
 *     // ❌ Runner фильтрует events
 *     if (event.type === 'OrderPartiallyFilled') {
 *       return; // ❌ фильтрация
 *     }
 *
 *     // ...
 *   }
 * }
 * ```
 */

/**
 * IStrategyRunner interface
 *
 * @remarks
 * Runner = lifecycle + wiring.
 * NO логики, NO фильтрации, NO знания о state.
 *
 * Единственные responsibilities:
 * - start() - запустить стратегию
 * - stop() - остановить стратегию
 *
 * Runner НЕ знает:
 * - Про state стратегии
 * - Про intents
 * - Про FSM transitions (кроме violations)
 * - Про market conditions
 *
 * Runner = просто lifecycle менеджер.
 */
export interface IStrategyRunner {
  /**
   * Start strategy
   *
   * @remarks
   * Запускает стратегию и начинает lifecycle.
   *
   * v4 алгоритм:
   * 1. Call strategy.onStart(ctx) → [] (NO intents в v3!)
   * 2. Subscribe to EventBus (ExecutionEvent + LifecycleEvent)
   * 3. Start tick timer (setInterval для onTick)
   * 4. v4: Publish LifecycleEvent: StrategyStarted
   *
   * КРИТИЧНО v4:
   * - StrategyStarted публикуется ПОСЛЕ onStart()
   * - StrategyStarted публикуется ПОСЛЕ подписки на events
   * - Это ЕДИНСТВЕННЫЙ способ для стратегии начать действовать
   *
   * @example
   * ```typescript
   * const runner = new StrategyRunner(strategy, ctx, executor, eventBus, 1000, logger);
   * runner.start();
   * // → strategy.onStart() called
   * // → EventBus subscriptions active
   * // → tick timer started
   * // → LifecycleEvent: StrategyStarted published
   * // → strategy receives StrategyStarted → first intent
   * ```
   */
  start(): void;

  /**
   * Stop strategy
   *
   * @remarks
   * Останавливает стратегию и cleanup.
   *
   * Алгоритм:
   * 1. Stop tick timer (clearInterval)
   * 2. Unsubscribe from EventBus
   * 3. Call strategy.onStop()
   *
   * v4: Опционально публикует LifecycleEvent: StrategyStopped
   *
   * @example
   * ```typescript
   * runner.stop();
   * // → tick timer stopped
   * // → EventBus unsubscribed
   * // → strategy.onStop() called
   * ```
   */
  stop(): void;
}
