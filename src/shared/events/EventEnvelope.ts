import type { ExecutionContext } from '../../domain/execution/ExecutionContext.js';

/**
 * EventEnvelope - base metadata wrapper
 *
 * @remarks
 * payload - opaque, EventBus маршрутизирует по envelope.type
 *
 * Принципы:
 * - type: string из payload.type (для ExecutionEvent/ExecutionErrorEvent) или DomainEvent.eventName
 * - payload: OPAQUE - EventBus не читает payload, только доставляет
 * - executionContext: для Decision Layer (environment + accountId)
 * - correlationId: для distributed tracing
 *
 * sequenceNumber НЕ optional - см. ProductionEnvelope vs ReplayEnvelope
 */
export interface BaseEventEnvelope<E> {
  readonly id: string;
  readonly type: string;
  readonly payload: E;
  readonly timestamp: Date;
  readonly executionContext: ExecutionContext; // для Decision Layer
  readonly correlationId?: string;
}

/**
 * ProductionEnvelope - для production (LIVE, PAPER)
 *
 * @remarks
 * sequenceNumber OPTIONAL
 * - ProductionEventBus ИГНОРИРУЕТ sequenceNumber (FIFO strict)
 * - sequenceNumber может использоваться для event sourcing persistence
 * - НО NOT для ordering в ProductionEventBus
 *
 * @example
 * ```typescript
 * const envelope: ProductionEnvelope<ExecutionEvent> = {
 *   id: '123-abc',
 *   type: 'OrderAccepted',
 *   payload: orderAcceptedEvent,
 *   timestamp: new Date(),
 *   executionContext: { environment: 'LIVE', accountId: 'main' },
 *   sequenceNumber: 42 // optional
 * };
 * ```
 */
export interface ProductionEnvelope<E> extends BaseEventEnvelope<E> {
  readonly sequenceNumber?: number; // Optional для production
}

/**
 * ReplayEnvelope - для replay (REPLAY environment)
 *
 * @remarks
 * sequenceNumber REQUIRED
 * - ReplayEventBus СОРТИРУЕТ по sequenceNumber
 * - Deterministic replay
 * - Runtime invariant: ReplayEventBus.publish() проверяет sequenceNumber !== undefined
 *
 * @example
 * ```typescript
 * const envelope: ReplayEnvelope<ExecutionEvent> = {
 *   id: '123-abc',
 *   type: 'OrderAccepted',
 *   payload: orderAcceptedEvent,
 *   timestamp: new Date(),
 *   executionContext: { environment: 'REPLAY', accountId: 'backtest-xyz' },
 *   sequenceNumber: 42 // REQUIRED для replay
 * };
 * ```
 */
export interface ReplayEnvelope<E> extends BaseEventEnvelope<E> {
  readonly sequenceNumber: number; // REQUIRED для replay
}

/**
 * EventEnvelope - union type для flexibility
 *
 * @remarks
 * Используется как общий тип для обоих envelopes.
 * EventBus принимает EventEnvelope<E>, но фактически может быть
 * ProductionEnvelope<E> или ReplayEnvelope<E>.
 */
export type EventEnvelope<E> = ProductionEnvelope<E> | ReplayEnvelope<E>;

/**
 * Создаёт ProductionEnvelope для ExecutionEvent
 *
 * @param payload - Event payload (ExecutionEvent, ExecutionErrorEvent, DomainEvent)
 * @param executionContext - Execution context (environment + accountId)
 * @param correlationId - Correlation ID для distributed tracing (optional)
 * @param sequenceNumber - Sequence number для event sourcing (optional)
 * @returns ProductionEnvelope<E>
 *
 * @remarks
 * executionContext ОБЯЗАТЕЛЕН (для Decision Layer)
 *
 * @example
 * ```typescript
 * const envelope = createProductionEnvelope(
 *   { type: 'OrderAccepted', orderId: '123', side: 'BUY', marketId: 'abc', price: 100, size: 10 },
 *   { environment: 'LIVE', accountId: 'main' }
 * );
 * ```
 */
export function createProductionEnvelope<E extends { type: string }>(
  payload: E,
  executionContext: ExecutionContext,
  correlationId?: string,
  sequenceNumber?: number
): ProductionEnvelope<E> {
  return {
    id: generateEventId(),
    type: payload.type, // EventBus маршрутизирует по этому полю
    payload,
    timestamp: new Date(),
    executionContext,
    correlationId,
    sequenceNumber,
  };
}

/**
 * Создаёт ReplayEnvelope для ExecutionEvent
 *
 * @param payload - Event payload (ExecutionEvent, ExecutionErrorEvent, DomainEvent)
 * @param executionContext - Execution context (environment + accountId)
 * @param sequenceNumber - Sequence number (REQUIRED для replay)
 * @param correlationId - Correlation ID для distributed tracing (optional)
 * @returns ReplayEnvelope<E>
 *
 * @remarks
 * sequenceNumber REQUIRED (compile-time check)
 *
 * @example
 * ```typescript
 * const envelope = createReplayEnvelope(
 *   { type: 'OrderAccepted', orderId: '123', side: 'BUY', marketId: 'abc', price: 100, size: 10 },
 *   { environment: 'REPLAY', accountId: 'backtest-2024-01-01' },
 *   42 // sequenceNumber REQUIRED
 * );
 * ```
 */
export function createReplayEnvelope<E extends { type: string }>(
  payload: E,
  executionContext: ExecutionContext,
  sequenceNumber: number, // REQUIRED
  correlationId?: string
): ReplayEnvelope<E> {
  return {
    id: generateEventId(),
    type: payload.type,
    payload,
    timestamp: new Date(),
    executionContext,
    correlationId,
    sequenceNumber,
  };
}

/**
 * Генерирует уникальный ID для event envelope
 *
 * @returns Уникальный string ID (timestamp + random)
 *
 * @remarks
 * Формат: `${timestamp}-${random}`
 * - timestamp: Date.now()
 * - random: base36 string (7 chars)
 *
 * @example
 * ```typescript
 * const id = generateEventId();
 * // id = "1704067200000-abc123f"
 * ```
 */
function generateEventId(): string {
  const ts = Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `${ts}-${random}`;
}
