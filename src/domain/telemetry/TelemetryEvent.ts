/**
 * TelemetryEvent - события наблюдаемости стратегии
 *
 * @remarks
 * КРИТИЧНО v2: Telemetry = паразит, НЕ субъект
 *
 * Telemetry:
 * - Детерминирована от StrategyEvent (НЕ наоборот!)
 * - Можно полностью отключить (NO влияния на behaviour)
 * - НЕ валидируется в tests (проверяем только execution факты)
 *
 * Жёсткое правило:
 * Если ты валидируешь логику по telemetry — ты сломал модель.
 * Telemetry — паразит (наблюдатель), НЕ субъект (участник).
 *
 * v4 changes:
 * - Timestamp = ctx.now() → clock.now() (deterministic!)
 * - NO new Date() в telemetry
 * - Replay = bit-for-bit те же timestamps
 *
 * @example
 * ```typescript
 * // ✅ ПРАВИЛЬНО: генерируем telemetry ПОСЛЕ FSM transition
 * this.state = reduce(this.state, event); // FSM transition
 * this.emitTelemetry(ctx, { type: 'STATE_CHANGED', ... }); // Telemetry паразит
 *
 * // ❌ НЕПРАВИЛЬНО: используем telemetry для принятия решений
 * if (telemetryEvent.type === 'STATE_CHANGED') { // ❌ ЗАПРЕЩЕНО
 *   this.state = ...;
 * }
 * ```
 *
 * @example
 * ```typescript
 * // v4: Telemetry с deterministic timestamps
 * private emitTelemetry(ctx: StrategyContext, event: Omit<TelemetryEvent, 'timestamp' | 'strategyId'>): void {
 *   this.telemetrySink.emit({
 *     timestamp: ctx.now(), // ✅ deterministic (clock injection)
 *     strategyId: this.id,
 *     ...event,
 *   });
 * }
 * ```
 */

/**
 * TelemetryCategory - категория telemetry события
 *
 * @remarks
 * STATE: изменения состояния FSM
 * DECISION: принятые решения (intents)
 * METRIC: наблюдаемые метрики
 */
export type TelemetryCategory = 'STATE' | 'DECISION' | 'METRIC';

/**
 * BaseTelemetryEvent - базовое telemetry событие
 */
export interface BaseTelemetryEvent {
  /** Timestamp (v4: from ctx.now() → clock) */
  readonly timestamp: Date;

  /** Strategy ID */
  readonly strategyId: string;

  /** Category */
  readonly category: TelemetryCategory;

  /** Event type */
  readonly type: string;

  /** Event payload */
  readonly payload: unknown;
}

/**
 * StateChangedEvent - изменение состояния FSM
 *
 * @remarks
 * Эмитится ПОСЛЕ FSM transition (паразит).
 * НЕ влияет на логику (только observability).
 *
 * @example
 * ```typescript
 * const oldState = this.state;
 * this.state = reduce(this.state, event); // FSM transition
 *
 * // Telemetry ПОСЛЕ transition:
 * if (oldState.tag !== this.state.tag) {
 *   this.emitTelemetry(ctx, {
 *     category: 'STATE',
 *     type: 'STATE_CHANGED',
 *     payload: {
 *       from: oldState.tag,
 *       to: this.state.tag,
 *     },
 *   }); // timestamp = ctx.now()
 * }
 * ```
 */
export interface StateChangedEvent extends BaseTelemetryEvent {
  readonly category: 'STATE';
  readonly type: 'STATE_CHANGED';
  readonly payload: {
    from: string;
    to: string;
  };
}

/**
 * IntentCreatedEvent - создан intent
 *
 * @remarks
 * Эмитится ПОСЛЕ генерации intents (паразит).
 * НЕ влияет на логику (только observability).
 *
 * @example
 * ```typescript
 * const intent: StrategyIntent = {
 *   type: 'PlaceOrder',
 *   params: { ... },
 *   reason: 'Initial quote',
 * };
 *
 * // Telemetry ПОСЛЕ создания intent:
 * this.emitTelemetry(ctx, {
 *   category: 'DECISION',
 *   type: 'INTENT_CREATED',
 *   payload: {
 *     intentType: intent.type,
 *     reason: intent.reason,
 *   },
 * }); // timestamp = ctx.now()
 *
 * return [intent];
 * ```
 */
export interface IntentCreatedEvent extends BaseTelemetryEvent {
  readonly category: 'DECISION';
  readonly type: 'INTENT_CREATED';
  readonly payload: {
    intentType: string;
    reason?: string;
  };
}

/**
 * MetricEvent - наблюдаемая метрика
 *
 * @remarks
 * Используется для metrics/observability.
 * Может содержать любые числовые метрики.
 *
 * @example
 * ```typescript
 * this.emitTelemetry(ctx, {
 *   category: 'METRIC',
 *   type: 'POSITION_SIZE',
 *   payload: {
 *     size: 100,
 *     value: 5200,
 *   },
 * });
 * ```
 */
export interface MetricEvent extends BaseTelemetryEvent {
  readonly category: 'METRIC';
  readonly type: string;
  readonly payload: Record<string, number>;
}

/**
 * TelemetryEvent union type
 */
export type TelemetryEvent = StateChangedEvent | IntentCreatedEvent | MetricEvent;
