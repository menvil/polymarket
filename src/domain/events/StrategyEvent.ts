/**
 * StrategyEvent - union для FSM reducer
 *
 * @remarks
 * КРИТИЧНО v4: Union, но каждый тип сохраняет свою семантику.
 *
 * FSM reducer принимает StrategyEvent = ExecutionEvent | LifecycleEvent.
 * Но типы остаются разделёнными (честные типы).
 *
 * Разделение типов (v4):
 * - ExecutionEvent = external facts (биржа, CLOB API)
 * - LifecycleEvent = internal facts (runtime, strategy lifecycle)
 *
 * Почему union:
 * - FSM reducer должен обрабатывать оба типа событий
 * - Но типы остаются разделёнными (НЕ смешиваются)
 * - Type guards работают корректно
 *
 * Replay:
 * - ExecutionEvent реплеится из биржевых логов
 * - LifecycleEvent инжектится replay system'ой
 *
 * @example
 * ```typescript
 * // FSM reducer принимает StrategyEvent:
 * function reduce(
 *   state: DumbStrategyStateData,
 *   event: StrategyEvent, // ✅ Union
 *   config: DumbStrategyConfig
 * ): DumbStrategyStateData {
 *   // Type guards работают:
 *   if (isLifecycleEvent(event)) {
 *     // event: LifecycleEvent
 *     if (event.type === 'StrategyStarted') {
 *       // ...
 *     }
 *   } else {
 *     // event: ExecutionEvent
 *     if (event.type === 'OrderAccepted') {
 *       // ...
 *     }
 *   }
 * }
 * ```
 */

import type { ExecutionEvent } from './ExecutionEvent.js';
import type { LifecycleEvent } from './LifecycleEvent.js';
import type { StrategyTick } from './TickEvent.js';

/**
 * StrategyEvent - union для FSM
 *
 * @remarks
 * КРИТИЧНО v5: Включает Tick events!
 * FSM reducer = single entry point для ВСЕХ событий.
 *
 * Разделение типов:
 * - ExecutionEvent = external facts (биржа)
 * - LifecycleEvent = internal facts (runtime)
 * - StrategyTick = time events (periodic ticks)
 *
 * FSM reducer = (state, StrategyEvent) → newState
 *
 * v4: Честные типы - ExecutionEvent ≠ LifecycleEvent ≠ StrategyTick
 * Но FSM reducer обрабатывает все три (через union)
 */
export type StrategyEvent = ExecutionEvent | LifecycleEvent | StrategyTick;

/**
 * Type guard: является ли событие ExecutionEvent
 *
 * @param event - StrategyEvent для проверки
 * @returns true если event это ExecutionEvent
 *
 * @remarks
 * Проверяет принадлежность к ExecutionEvent типам:
 * - OrderAccepted
 * - OrderPartiallyFilled
 * - OrderFilled
 * - OrderCancelled
 * - OrderRejected
 *
 * @example
 * ```typescript
 * if (isExecutionEvent(event)) {
 *   // event: ExecutionEvent
 *   console.log('Execution event:', event.type);
 * }
 * ```
 */
export function isExecutionEvent(event: StrategyEvent): event is ExecutionEvent {
  return [
    'OrderAccepted',
    'OrderPartiallyFilled',
    'OrderFilled',
    'OrderCancelled',
    'OrderRejected',
  ].includes(event.type);
}

/**
 * Type guard: является ли событие LifecycleEvent
 *
 * @param event - StrategyEvent для проверки
 * @returns true если event это LifecycleEvent
 *
 * @remarks
 * Проверяет принадлежность к LifecycleEvent типам:
 * - StrategyStarted
 * - StrategyStopped
 *
 * @example
 * ```typescript
 * if (isLifecycleEvent(event)) {
 *   // event: LifecycleEvent
 *   console.log('Lifecycle event:', event.type);
 * }
 * ```
 */
export function isLifecycleEvent(event: StrategyEvent): event is LifecycleEvent {
  return ['StrategyStarted', 'StrategyStopped'].includes(event.type);
}

/**
 * Type guard: является ли событие StrategyTick
 *
 * @param event - StrategyEvent для проверки
 * @returns true если event это StrategyTick
 *
 * @remarks
 * Проверяет принадлежность к StrategyTick типу.
 * Используется для обработки периодических тиков в FSM reducer.
 *
 * @example
 * ```typescript
 * if (isTickEvent(event)) {
 *   // event: StrategyTick
 *   console.log('Tick event at:', event.timestamp);
 * }
 * ```
 */
export function isTickEvent(event: StrategyEvent): event is StrategyTick {
  return event.type === 'StrategyTick';
}
