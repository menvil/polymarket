/**
 * StrategyRunner - ТУПОЙ lifecycle менеджер
 *
 * @remarks
 * КРИТИЧНО v4: NO логики принятия решений!
 *
 * Runner делает (v4):
 * - lifecycle (start/stop)
 * - wiring (подписка на EventBus)
 * - публикация LifecycleEvent: StrategyStarted ПОСЛЕ onStart()
 * - таймер (setInterval для onTick)
 * - FSM violation handling (catch → stop)
 *
 * Runner НЕ делает:
 * - НЕ знает про state стратегии
 * - НЕ принимает решений (кроме "stop на FSM violation")
 * - НЕ читает strategy.state
 *
 * v4 changes:
 * - Публикует LifecycleEvent: StrategyStarted через EventBus
 * - Подписывается на ExecutionEvent И LifecycleEvent
 * - Использует EventEnvelope API (новый API EventBus)
 *
 * @example
 * ```typescript
 * const runner = new StrategyRunner(
 *   strategy,
 *   ctx,
 *   executor,
 *   eventBus,
 *   executionContext,
 *   1000, // tick interval
 *   logger
 * );
 *
 * runner.start();
 * // → strategy.onStart() called → []
 * // → EventBus subscriptions active
 * // → tick timer started
 * // → LifecycleEvent: StrategyStarted published
 * // → strategy receives StrategyStarted → first intent
 *
 * runner.stop();
 * // → tick timer stopped
 * // → EventBus unsubscribed
 * // → strategy.onStop() called
 * ```
 */

import type { IStrategyRunner } from '../../domain/strategies/IStrategyRunner.js';
import type { IStrategy } from '../../domain/strategies/IStrategy.js';
import type { StrategyContext } from '../../domain/strategies/StrategyContext.js';
import type { IStrategyExecutor } from '../../domain/strategies/IStrategyExecutor.js';
import type { IEventBus } from '../../shared/events/IEventBus.js';
import type { EventEnvelope } from '../../shared/events/EventEnvelope.js';
import type { StrategyEvent } from '../../domain/events/StrategyEvent.js';
import type { StrategyTick } from '../../domain/events/TickEvent.js';
import type { ExecutionContext } from '../../domain/execution/ExecutionContext.js';
import type { ILogger } from '../../domain/ports/ILogger.js';
import type { IStrategyMetricsProjector } from '../services/StrategyMetricsProjector.js';
import type { IPortfolioProjector } from '../../domain/services/portfolio/PortfolioProjector.js';
import { createProductionEnvelope } from '../../shared/events/EventEnvelope.js';

/**
 * StrategyRunner - dumb lifecycle manager
 *
 * @remarks
 * КРИТИЧНО v4:
 * - NO логики принятия решений
 * - NO знания о state стратегии
 * - Публикует LifecycleEvent: StrategyStarted ПОСЛЕ onStart()
 * - Ловит FSM violations → stop()
 * - Использует EventEnvelope API
 *
 * Философия v4:
 * - Runner = просто lifecycle + wiring
 * - Strategy = decision maker
 * - Executor = intent executor
 * - Runner НЕ принимает решений
 *
 * @example
 * ```typescript
 * const runner = new StrategyRunner(
 *   strategy,
 *   ctx,
 *   executor,
 *   eventBus,
 *   { environment: 'LIVE', accountId: 'main' },
 *   1000,
 *   logger
 * );
 *
 * runner.start();
 * // → lifecycle started
 *
 * runner.stop();
 * // → lifecycle stopped
 * ```
 */
export class StrategyRunner implements IStrategyRunner {
  private tickIntervalId?: NodeJS.Timeout;
  private unsubscribeFunctions: Array<() => void> = [];
  private isRunning: boolean = false;

  /**
   * @param strategy - Strategy instance
   * @param ctx - Strategy context (sandbox)
   * @param executor - Intent executor
   * @param eventBus - Event bus for publishing/subscribing
   * @param executionContext - Execution context (environment + accountId)
   * @param tickIntervalMs - Tick interval in milliseconds
   * @param logger - Logger for errors
   * @param metricsProjector - Metrics projector (optional, для обновления метрик)
   * @param portfolioProjector - Portfolio projector (optional, для расчёта PnL)
   *
   * @remarks
   * КРИТИЧНО v4.2: Projectors НЕ опциональные в production!
   * Они нужны для правильной работы event sourcing.
   * Если не передать projectors → метрики и PnL не будут обновляться!
   */
  constructor(
    private readonly strategy: IStrategy,
    private readonly ctx: StrategyContext,
    private readonly executor: IStrategyExecutor,
    private readonly eventBus: IEventBus,
    private readonly executionContext: ExecutionContext,
    private readonly tickIntervalMs: number,
    private readonly logger: ILogger,
    private readonly metricsProjector?: IStrategyMetricsProjector,
    // @ts-expect-error - portfolioProjector for future use when OrderFilled events are restored
    private readonly _portfolioProjector?: IPortfolioProjector
  ) {}

  /**
   * Start strategy
   *
   * @remarks
   * v4 алгоритм:
   * 1. Call strategy.onStart(ctx) → [] (NO intents в v3!)
   * 2. Subscribe to EventBus (ExecutionEvent + LifecycleEvent)
   * 3. Start tick timer
   * 4. v4: Publish LifecycleEvent: StrategyStarted
   *
   * КРИТИЧНО v4:
   * - StrategyStarted публикуется ПОСЛЕ onStart()
   * - StrategyStarted публикуется ПОСЛЕ подписки на events
   * - Это ЕДИНСТВЕННЫЙ способ для стратегии начать действовать
   */
  start(): void {
    this.logger.info(`[StrategyRunner] Starting strategy ${this.strategy.id}`);

    // 1. Call strategy.onStart()
    // КРИТИЧНО v3: onStart() возвращает [] (NO intents!)
    try {
      const intents = this.strategy.onStart(this.ctx);
      if (intents.length > 0) {
        this.logger.warn(`[StrategyRunner] onStart() returned intents (should be empty in v3)`, {
          count: intents.length,
        });
      }
      this.executor.execute(intents, this.ctx); // Исполняем (даже если пустой)
    } catch (error) {
      this.logger.error(`[StrategyRunner] Error in onStart`, error);
      return; // НЕ продолжаем если onStart() failed
    }

    // 2. Subscribe to EventBus
    // КРИТИЧНО v4: подписываемся на ExecutionEvent И LifecycleEvent
    // Используем handler wrapper для type casting
    const unsubStrategyStarted = this.eventBus.subscribe(
      'StrategyStarted',
      (envelope) => this.onStrategyEvent(envelope as EventEnvelope<StrategyEvent>)
    );
    const unsubStrategyStopped = this.eventBus.subscribe(
      'StrategyStopped',
      (envelope) => this.onStrategyEvent(envelope as EventEnvelope<StrategyEvent>)
    );
    const unsubOrderAccepted = this.eventBus.subscribe(
      'OrderAccepted',
      (envelope) => this.onStrategyEvent(envelope as EventEnvelope<StrategyEvent>)
    );
    // ✅ v7.7.15: OrderPartiallyFilled УДАЛЁН - стратегия работает только по StrategyTick!
    // const unsubPartiallyFilled = this.eventBus.subscribe('OrderPartiallyFilled', ...);
    // ✅ v7.7.15: OrderFilled УДАЛЁН - стратегия работает только по StrategyTick!
    // const unsubFilled = this.eventBus.subscribe('OrderFilled', ...);
    const unsubCancelled = this.eventBus.subscribe(
      'OrderCancelled',
      (envelope) => this.onStrategyEvent(envelope as EventEnvelope<StrategyEvent>)
    );
    const unsubRejected = this.eventBus.subscribe(
      'OrderRejected',
      (envelope) => this.onStrategyEvent(envelope as EventEnvelope<StrategyEvent>)
    );
    const unsubStrategyTick = this.eventBus.subscribe(
      'StrategyTick',
      (envelope) => this.onStrategyEvent(envelope as EventEnvelope<StrategyEvent>)
    );

    this.unsubscribeFunctions.push(
      unsubStrategyStarted,
      unsubStrategyStopped,
      unsubOrderAccepted,
      // unsubPartiallyFilled, // ✅ v7.7.15: УДАЛЁН
      // unsubFilled, // ✅ v7.7.15: УДАЛЁН
      unsubCancelled,
      unsubRejected,
      unsubStrategyTick
    );

    // 3. Start tick timer
    this.tickIntervalId = setInterval(() => {
      this.onTick();
    }, this.tickIntervalMs);

    this.isRunning = true;

    // 4. КРИТИЧНО v4: Публикуем LifecycleEvent: StrategyStarted ПОСЛЕ подписки
    // Это ЕДИНСТВЕННЫЙ способ для стратегии начать действовать
    this.logger.debug(`[StrategyRunner] Publishing StrategyStarted event`);

    const strategyStartedEvent = {
      type: 'StrategyStarted' as const,
      strategyId: this.strategy.id,
      timestamp: this.ctx.now(), // ✅ deterministic (clock injection)
    };

    const envelope = createProductionEnvelope(
      strategyStartedEvent,
      this.executionContext,
      undefined, // correlationId
      undefined // sequenceNumber (optional для production)
    );

    this.eventBus.publish(envelope);

    this.logger.info(`[StrategyRunner] Strategy ${this.strategy.id} started`);
  }

  /**
   * Stop strategy
   *
   * @remarks
   * Алгоритм:
   * 1. Stop tick timer (clearInterval)
   * 2. Unsubscribe from EventBus
   * 3. Call strategy.onStop()
   */
  stop(): void {
    if (!this.isRunning) {
      this.logger.warn(`[StrategyRunner] Strategy ${this.strategy.id} already stopped`);
      return;
    }

    this.logger.info(`[StrategyRunner] Stopping strategy ${this.strategy.id}`);

    this.isRunning = false;

    // 1. Stop tick timer
    if (this.tickIntervalId) {
      clearInterval(this.tickIntervalId);
      this.tickIntervalId = undefined;
    }

    // 2. ✅ v5.5: Отменить активный ордер если есть
    const activeOrderId = this.strategy.getCurrentOrderId?.();
    if (activeOrderId) {
      this.logger.info(`[StrategyRunner] Cancelling active order ${activeOrderId} before stop`);
      try {
        this.ctx.cancelOrder(activeOrderId);
      } catch (error) {
        this.logger.error(`[StrategyRunner] Error cancelling order on stop`, error);
      }
    }

    // 3. Unsubscribe from EventBus
    for (const unsub of this.unsubscribeFunctions) {
      unsub();
    }
    this.unsubscribeFunctions = [];

    // 4. Call strategy.onStop()
    try {
      this.strategy.onStop();
    } catch (error) {
      this.logger.error(`[StrategyRunner] Error in onStop`, error);
    }

    this.logger.info(`[StrategyRunner] Strategy ${this.strategy.id} stopped`);
  }

  /**
   * onTick handler
   *
   * @remarks
   * КРИТИЧНО v5: Публикуем StrategyTick event через EventBus!
   *
   * v5 changes:
   * - НЕ вызываем strategy.onTick() напрямую
   * - Публикуем StrategyTick event
   * - strategy.onExecutionEvent() обработает StrategyTick через union
   * - Это обеспечивает детерминированный replay тиков
   *
   * @example
   * ```typescript
   * // Каждый tick:
   * // 1. onTick() публикует StrategyTick
   * // 2. EventBus доставляет StrategyTick → onStrategyEvent
   * // 3. onStrategyEvent вызывает strategy.onExecutionEvent(StrategyTick)
   * // 4. DumbStrategy обрабатывает StrategyTick (возвращает [])
   * ```
   */
  private onTick(): void {
    if (!this.isRunning) {
      return; // Skip if stopped
    }

    // ✅ Публикуем StrategyTick event через EventBus
    const tickEvent: StrategyTick = {
      type: 'StrategyTick',
      strategyId: this.strategy.id,
      timestamp: this.ctx.now(), // Детерминированное время!
    };

    const envelope = createProductionEnvelope(
      tickEvent,
      this.executionContext
    );

    this.eventBus.publish(envelope);

    // ПРИМЕЧАНИЕ v5: onExecutionEvent уже обрабатывает StrategyTick (через union StrategyEvent)
  }

  /**
   * onStrategyEvent handler
   *
   * @param envelope - Event envelope (ExecutionEvent | LifecycleEvent)
   *
   * @remarks
   * КРИТИЧНО v4: NO фильтрации, тупо передаём event в стратегию
   *
   * НО: ловим FSM violation → stop()
   *
   * v4 changes:
   * - Принимает EventEnvelope<StrategyEvent>
   * - StrategyEvent = ExecutionEvent | LifecycleEvent
   *
   * v4.3 changes (CRITICAL FIX):
   * - Фильтрация по strategyId ПЕРЕД вызовом projectors!
   * - Это предотвращает дублирование счётчиков (каждый event = 1 increment)
   * - metricsProjector.project(event) только для событий этой стратегии
   * - portfolioProjector.project(event) только для OrderFilled
   */
  private onStrategyEvent(envelope: EventEnvelope<StrategyEvent>): void {
    if (!this.isRunning) {
      return; // Skip if stopped
    }

    const event = envelope.payload;

    // ✅ КРИТИЧНО: Фильтрация по strategyId для стратегии!
    // Без этого ВСЕ runners получают события ВСЕХ стратегий!
    // ВАЖНО: Фильтруем ПЕРЕД project() чтобы избежать дублирования!
    //
    // ✅ v7.7.14: CRITICAL FIX - Allow events with undefined strategyId (broadcast)!
    // Problem: OrderReconciliationService may publish OrderFilled with strategyId=undefined
    // when order disappears from trackedOrders before fill is detected.
    // Old logic: `if ('strategyId' in event && event.strategyId !== this.strategy.id)`
    // This filtered OUT events where strategyId=undefined because undefined !== strategy.id!
    // New logic: Only filter if strategyId is EXPLICITLY SET to a different strategy.
    if ('strategyId' in event && event.strategyId !== undefined && event.strategyId !== this.strategy.id) {
      // ✅ v7.7.15: OrderFilled УДАЛЁН - стратегия работает только по StrategyTick!
      // Debug logging removed
      return; // Event для другой стратегии - игнорируем
    }

    // ✅ v4.3 FIX: Вызываем metricsProjector ПОСЛЕ фильтрации по strategyId!
    // Это предотвращает дублирование счётчиков когда несколько runners
    // разделяют один metricsProjector instance.
    if (this.metricsProjector) {
      this.metricsProjector.project(event);
    }

    try {

      // ✅ INFO: Логируем OrderAccepted
      if (event.type === 'OrderAccepted') {
        this.logger.info('[StrategyRunner] ✓ Order accepted', {
          strategyId: this.strategy.id.substring(0, 20) + '...',
          orderId: event.orderId.substring(0, 12) + '...',
          side: event.side,
          price: event.price.toFixed(4),
          size: event.size,
        });
      }

      // ✅ v7.7.15: OrderFilled УДАЛЁН - стратегия работает только по StrategyTick!
      // Portfolio projector DISABLED (fills not used for strategy decisions)
      // Inventory syncs через OrderReconciliationService каждые 4 секунды

      // Далее: передаём event в стратегию как обычно
      const intents = this.strategy.onExecutionEvent(event, this.ctx);
      this.executor.execute(intents, this.ctx);
    } catch (error) {
      // КРИТИЧНО v3: FSM violation → stop runner
      // Улучшенное логирование ошибки
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      const errorName = error instanceof Error ? error.name : typeof error;

      this.logger.error(`[StrategyRunner] FSM violation or error in onExecutionEvent, stopping strategy`, {
        errorMessage,
        errorName,
        errorStack,
        event: envelope.payload.type,
        strategyId: this.strategy.id,
      });

      // Stop runner (не пытаемся продолжить)
      this.stop();
    }
  }
}
