/**
 * LifecycleEvent - события lifecycle стратегии
 *
 * @remarks
 * КРИТИЧНО v4: Отдельный тип от ExecutionEvent!
 * Lifecycle events = факты runtime, НЕ биржи.
 *
 * Lifecycle events НЕ реплеятся из биржевых логов.
 * Они инжектятся runner'ом.
 *
 * Разделение типов (v4):
 * - ExecutionEvent = external facts (биржа, CLOB API)
 * - LifecycleEvent = internal facts (runtime, strategy lifecycle)
 * - NO смешивания: честные типы, разная семантика
 *
 * Примеры LifecycleEvent:
 * - StrategyStarted - стратегия запущена runner'ом
 * - StrategyStopped - стратегия остановлена runner'ом
 *
 * Примеры НЕ LifecycleEvent (это ExecutionEvent):
 * - OrderAccepted - факт биржи
 * - OrderFilled - факт биржи
 */

/**
 * StrategyStartedEvent - стратегия запущена
 *
 * @remarks
 * КРИТИЧНО v4: Это LifecycleEvent, НЕ ExecutionEvent!
 *
 * Семантика:
 * - Публикуется runner'ом ПОСЛЕ onStart()
 * - Первый event, который получает стратегия
 * - Инициирует первый intent (v3: onStart() возвращает [])
 * - Устанавливает initial state (например, lastSide)
 *
 * Отличие от ExecutionEvent:
 * - НЕ факт биржи (факт runtime)
 * - НЕ реплеится из биржевых логов
 * - Инжектится runner'ом
 *
 * Replay:
 * - Replay system инжектит StrategyStarted вручную
 * - НЕ включается в execution-stream из биржи
 *
 * @example
 * ```typescript
 * // Runner публикует:
 * eventBus.publish('StrategyStarted', {
 *   type: 'StrategyStarted',
 *   strategyId: strategy.id,
 *   timestamp: clock.now(), // deterministic
 * });
 *
 * // Стратегия реагирует:
 * onExecutionEvent(event: StrategyStarted, ctx) {
 *   // Первый intent
 *   return [PlaceOrderIntent(...)];
 * }
 * ```
 */
export interface StrategyStartedEvent {
  readonly type: 'StrategyStarted';
  readonly strategyId: string;
  readonly timestamp: Date; // v4: для deterministic replay
}

/**
 * StrategyStoppedEvent - стратегия остановлена
 *
 * @remarks
 * КРИТИЧНО v4: Это LifecycleEvent, НЕ ExecutionEvent!
 *
 * Семантика:
 * - Публикуется runner'ом при stop()
 * - Может содержать reason (normal stop, FSM violation, error, etc.)
 * - Последний event lifecycle'а
 *
 * Отличие от ExecutionEvent:
 * - НЕ факт биржи (факт runtime)
 * - НЕ реплеится из биржевых логов
 * - Инжектится runner'ом
 *
 * @example
 * ```typescript
 * // Runner публикует:
 * eventBus.publish('StrategyStopped', {
 *   type: 'StrategyStopped',
 *   strategyId: strategy.id,
 *   reason: 'FSM violation',
 *   timestamp: clock.now(),
 * });
 * ```
 */
export interface StrategyStoppedEvent {
  readonly type: 'StrategyStopped';
  readonly strategyId: string;
  readonly reason?: string; // Optional: 'normal', 'FSM violation', 'error', etc.
  readonly timestamp: Date; // v4: для deterministic replay
}

/**
 * LifecycleEvent union
 *
 * @remarks
 * ✅ ТОЛЬКО lifecycle события
 * ❌ NO execution events (OrderAccepted - это ExecutionEvent!)
 *
 * v4: Честные типы - LifecycleEvent ≠ ExecutionEvent
 */
export type LifecycleEvent =
  | StrategyStartedEvent
  | StrategyStoppedEvent;

// Type guards

/**
 * Type guard для StrategyStartedEvent
 */
export function isStrategyStarted(event: LifecycleEvent): event is StrategyStartedEvent {
  return event.type === 'StrategyStarted';
}

/**
 * Type guard для StrategyStoppedEvent
 */
export function isStrategyStopped(event: LifecycleEvent): event is StrategyStoppedEvent {
  return event.type === 'StrategyStopped';
}
