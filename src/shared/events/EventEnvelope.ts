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
 * Create a ProductionEnvelope for the given event payload.
 *
 * The envelope's `type` is taken from `payload.type` and the envelope is assigned a generated `id` and current `timestamp`.
 *
 * @param payload - Event payload; must include a `type` string
 * @param executionContext - Execution context (environment and accountId); required for Decision Layer
 * @param correlationId - Optional correlation ID for distributed tracing
 * @param sequenceNumber - Optional sequence number used by event sourcing (may be omitted in production)
 * @returns A ProductionEnvelope wrapping `payload` with generated `id`, `timestamp`, the provided `executionContext`, and any supplied `correlationId` and `sequenceNumber`
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
 * Create a ReplayEnvelope for the given event payload.
 *
 * @param payload - Event payload; must include a `type` string.
 * @param executionContext - Execution context containing environment and accountId.
 * @param sequenceNumber - Sequence number used to deterministically order events during replay; required.
 * @param correlationId - Optional correlation ID for distributed tracing.
 * @returns A ReplayEnvelope wrapping the payload with replay-specific metadata.
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
 * Generates a unique identifier for an event envelope.
 *
 * The identifier combines the current timestamp and a random suffix.
 *
 * @returns A string in the format `<timestamp>-<random>`, where `timestamp` is milliseconds since the Unix epoch and `random` is a 7-character base-36 string.
 */
function generateEventId(): string {
  const ts = Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `${ts}-${random}`;
}