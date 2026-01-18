/**
 * IStrategy - контракт торговой стратегии
 *
 * @remarks
 * КРИТИЧНО v4: NO logger в контракте!
 * Стратегия НЕ логирует, она эмитит telemetry.
 *
 * Lifecycle:
 * 1. onStart(ctx) → [] (NO intents! v3)
 * 2. Runner публикует LifecycleEvent: StrategyStarted
 * 3. onExecutionEvent(StrategyStarted: LifecycleEvent, ctx) → первый intent (v4)
 * 4. onTick(ctx) → intents (NO state changes!)
 * 5. onExecutionEvent(event: StrategyEvent, ctx) → intents (единственный способ изменить state)
 * 6. onStop() → cleanup
 *
 * Жёсткие правила v4:
 * - onStart() НЕ генерирует intents (только инициализация)
 * - onTick() НЕ меняет state (только возвращает intents)
 * - onExecutionEvent() принимает StrategyEvent (ExecutionEvent | LifecycleEvent)
 * - onExecutionEvent() - ЕДИНСТВЕННЫЙ способ изменить state
 * - Стратегия НЕ получает logger (только telemetry sink)
 * - Стратегия НЕ знает про Runner/Executor
 * - State = fully event-sourced (восстанавливается из event stream)
 * - NO new Date() (только ctx.now() → clock)
 * - FSM violation → throw (NO catch)
 *
 * v4 changes:
 * - onExecutionEvent принимает StrategyEvent (union: ExecutionEvent | LifecycleEvent)
 * - LifecycleEvent = отдельный тип (честные типы)
 *
 * @example
 * ```typescript
 * class DumbStrategy implements IStrategy {
 *   // v3: state = fully event-sourced (включая currentOrderId, lastSide)
 *   private state: DumbStrategyStateData = { tag: 'IDLE' };
 *
 *   // v3: onStart() НЕ генерирует intents
 *   onStart(ctx: StrategyContext): StrategyIntent[] {
 *     // Только инициализация (если нужно)
 *     return []; // ✅ NO intents
 *   }
 *
 *   // v4: ЕДИНСТВЕННЫЙ способ изменить state - через StrategyEvent
 *   onExecutionEvent(event: StrategyEvent, ctx: StrategyContext): StrategyIntent[] {
 *     // v3: FSM violation → throw (NO catch)
 *     this.state = reduce(this.state, event); // ✅ throws on violation
 *
 *     // v4: emit telemetry with ctx.now() → clock
 *     this.emitTelemetry(ctx, { type: 'STATE_CHANGED', ... }); // ✅ deterministic
 *
 *     // v4: StrategyStarted (LifecycleEvent) → первый intent
 *     if (event.type === 'StrategyStarted') {
 *       return [new PlaceOrderIntent(...)]; // ✅ через событие
 *     }
 *
 *     return this.generateIntents(ctx);
 *   }
 *
 *   // onTick НЕ меняет state, только возвращает intents
 *   onTick(ctx: StrategyContext): StrategyIntent[] {
 *     if (this.state.tag === 'IDLE') {
 *       return []; // Ждём StrategyStarted
 *     }
 *     return [];
 *   }
 * }
 * ```
 */

import type { StrategyEvent } from '../events/StrategyEvent.js';
import type { StrategyContext } from './StrategyContext.js';
import type { StrategyIntent } from './StrategyIntent.js';

export interface IStrategy {
  /**
   * Strategy ID (unique identifier)
   */
  readonly id: string;

  /**
   * Lifecycle: Start
   *
   * @param ctx - Strategy context (sandbox)
   * @returns Empty array (NO intents! v3)
   *
   * @remarks
   * КРИТИЧНО v3: onStart() НЕ генерирует intents!
   *
   * onStart() используется ТОЛЬКО для:
   * - Инициализации internal state (если нужно)
   * - Setup (подготовка)
   *
   * Первый intent появляется только через LifecycleEvent: StrategyStarted (v4).
   * Runner публикует StrategyStarted ПОСЛЕ вызова onStart().
   *
   * Правило v3:
   * Если onStart() возвращает intents → это нарушение философии FSM.
   *
   * @example
   * ```typescript
   * onStart(ctx: StrategyContext): StrategyIntent[] {
   *   // Инициализация (если нужно)
   *   // this.someSetup();
   *
   *   return []; // ✅ ВСЕГДА пустой массив
   * }
   * ```
   */
  onStart(ctx: StrategyContext): StrategyIntent[]; // Всегда []

  /**
   * Lifecycle: Tick (periodic)
   *
   * @param ctx - Strategy context
   * @returns Intents (может быть пустым)
   *
   * @deprecated С v5: Используйте onExecutionEvent(StrategyTick) вместо этого
   *
   * @remarks
   * УСТАРЕВШЕЕ: onTick(ctx) больше НЕ вызывается напрямую!
   *
   * v5 changes:
   * - StrategyRunner публикует StrategyTick event через EventBus
   * - onExecutionEvent(StrategyTick) обрабатывает тики
   * - onTick() сохранён для обратной совместимости
   *
   * КРИТИЧНО v3: onTick() НЕ меняет state!
   *
   * onTick() может:
   * - Проверять состояние
   * - Возвращать intents
   *
   * onTick() НЕ может:
   * - Менять state напрямую (state меняется ТОЛЬКО через onExecutionEvent)
   * - Делать side-effects (только intents)
   *
   * Если нужно изменить state → дождись StrategyEvent.
   *
   * @example
   * ```typescript
   * // СТАРЫЙ КОД (deprecated):
   * onTick(ctx: StrategyContext): StrategyIntent[] {
   *   return []; // DumbStrategy игнорирует тики
   * }
   *
   * // НОВЫЙ КОД (v5):
   * onExecutionEvent(event: StrategyEvent, ctx: StrategyContext): StrategyIntent[] {
   *   if (event.type === 'StrategyTick') {
   *     return []; // DumbStrategy игнорирует тики
   *   }
   *   // ...
   * }
   * ```
   */
  onTick(ctx: StrategyContext): StrategyIntent[];

  /**
   * Lifecycle: StrategyEvent (ExecutionEvent | LifecycleEvent | StrategyTick)
   *
   * @param event - StrategyEvent (ExecutionEvent | LifecycleEvent | StrategyTick, v5!)
   * @param ctx - Strategy context
   * @returns Intents
   *
   * @remarks
   * КРИТИЧНО v5: ЕДИНСТВЕННЫЙ entry point FSM!
   * Обрабатывает ВСЕ события включая тики.
   *
   * Алгоритм:
   * 1. Применить event к FSM → new state (может throw!)
   * 2. Emit telemetry с ctx.now() → clock (deterministic, v4)
   * 3. Сгенерировать intents на основе new state
   * 4. Вернуть intents
   *
   * Жёсткие правила v5:
   * - StrategyEvent = Union<ExecutionEvent | LifecycleEvent | StrategyTick> (честные типы)
   * - FSM violation → throw (NO catch в стратегии, Runner обработает)
   * - Telemetry timestamp = ctx.now() → clock.now() (NO new Date())
   * - State = fully event-sourced (всё восстанавливается из event)
   *
   * v4 changes:
   * - event: StrategyEvent (вместо ExecutionEvent)
   * - Обрабатывает LifecycleEvent (StrategyStarted, StrategyStopped)
   * - ExecutionEvent и LifecycleEvent разделены (честные типы)
   *
   * v5 changes:
   * - Обрабатывает StrategyTick (periodic time events)
   * - onTick() deprecated, используйте onExecutionEvent(StrategyTick)
   *
   * @example
   * ```typescript
   * onExecutionEvent(event: StrategyEvent, ctx: StrategyContext): StrategyIntent[] {
   *   // Step 1: FSM transition (может throw!)
   *   const oldState = this.state;
   *   this.state = reduce(this.state, event); // ✅ throws on violation
   *
   *   // Step 2: Emit telemetry (паразит)
   *   if (oldState.tag !== this.state.tag) {
   *     this.emitTelemetry(ctx, {
   *       type: 'STATE_CHANGED',
   *       payload: { from: oldState.tag, to: this.state.tag }
   *     }); // ✅ ctx.now() → clock.now()
   *   }
   *
   *   // Step 3: React to event
   *   if (event.type === 'StrategyStarted') {
   *     // v4: LifecycleEvent → первый intent
   *     return [PlaceOrderIntent(...)];
   *   }
   *
   *   if (event.type === 'OrderFilled') {
   *     // ExecutionEvent → reverse order
   *     return [PlaceOrderIntent(...)];
   *   }
   *
   *   return [];
   * }
   * ```
   */
  onExecutionEvent(event: StrategyEvent, ctx: StrategyContext): StrategyIntent[];

  /**
   * Lifecycle: Stop
   *
   * @remarks
   * Вызывается Runner'ом при остановке стратегии.
   * Используется для cleanup (если нужно).
   *
   * @example
   * ```typescript
   * onStop(): void {
   *   // Cleanup (если нужно)
   *   // this.cleanup();
   * }
   * ```
   */
  onStop(): void;

  /**
   * Get current active order ID (if any)
   *
   * @returns Order ID or undefined if no active order
   *
   * @remarks
   * v5.2: Для отмены активных ордеров при остановке стратегии.
   * Используется Coordinator'ом для cleanup при удалении стратегии.
   *
   * @example
   * ```typescript
   * const orderId = strategy.getCurrentOrderId();
   * if (orderId) {
   *   ctx.cancelOrder(orderId);
   * }
   * ```
   */
  getCurrentOrderId?(): string | undefined;
}
