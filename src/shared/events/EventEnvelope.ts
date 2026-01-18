import type { ExecutionContext } from '../../domain/execution/ExecutionContext.js';

/**
 * EventEnvelope - базовая обёртка с метаданными
 *
 * @remarks
 * payload - непрозрачный, EventBus маршрутизирует по envelope.type
 *
 * Принципы:
 * - type: string из payload.type (для ExecutionEvent/ExecutionErrorEvent) или DomainEvent.eventName
 * - payload: НЕПРОЗРАЧНЫЙ - EventBus не читает payload, только доставляет
 * - executionContext: для Decision Layer (environment + accountId)
 * - correlationId: для распределённой трассировки
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
 * sequenceNumber ОПЦИОНАЛЕН
 * - ProductionEventBus ИГНОРИРУЕТ sequenceNumber (строгий FIFO)
 * - sequenceNumber может использоваться для event sourcing persistence
 * - НО НЕ для упорядочивания в ProductionEventBus
 *
 * @example
 * ```typescript
 * const envelope: ProductionEnvelope<ExecutionEvent> = {
 *   id: '123-abc',
 *   type: 'OrderAccepted',
 *   payload: orderAcceptedEvent,
 *   timestamp: new Date(),
 *   executionContext: { environment: 'LIVE', accountId: 'main' },
 *   sequenceNumber: 42 // опционален
 * };
 * ```
 */
export interface ProductionEnvelope<E> extends BaseEventEnvelope<E> {
  readonly sequenceNumber?: number; // Опционален для production
}

/**
 * ReplayEnvelope - для replay (среда REPLAY)
 *
 * @remarks
 * sequenceNumber ОБЯЗАТЕЛЕН
 * - ReplayEventBus СОРТИРУЕТ по sequenceNumber
 * - Детерминированное воспроизведение
 * - Runtime инвариант: ReplayEventBus.publish() проверяет sequenceNumber !== undefined
 *
 * @example
 * ```typescript
 * const envelope: ReplayEnvelope<ExecutionEvent> = {
 *   id: '123-abc',
 *   type: 'OrderAccepted',
 *   payload: orderAcceptedEvent,
 *   timestamp: new Date(),
 *   executionContext: { environment: 'REPLAY', accountId: 'backtest-xyz' },
 *   sequenceNumber: 42 // ОБЯЗАТЕЛЕН для replay
 * };
 * ```
 */
export interface ReplayEnvelope<E> extends BaseEventEnvelope<E> {
  readonly sequenceNumber: number; // ОБЯЗАТЕЛЕН для replay
}

/**
 * EventEnvelope - union тип для гибкости
 *
 * @remarks
 * Используется как общий тип для обоих envelopes.
 * EventBus принимает EventEnvelope<E>, но фактически может быть
 * ProductionEnvelope<E> или ReplayEnvelope<E>.
 */
export type EventEnvelope<E> = ProductionEnvelope<E> | ReplayEnvelope<E>;

/**
 * Создаёт ProductionEnvelope для ExecutionEvent или DomainEvent
 *
 * @param payload - Event payload с type (ExecutionEvent) или eventName (DomainEvent)
 * @param executionContext - Контекст выполнения (environment + accountId)
 * @param correlationId - Correlation ID для распределённой трассировки (опционален)
 * @param sequenceNumber - Порядковый номер для event sourcing (опционален)
 * @returns ProductionEnvelope<E>
 *
 * @remarks
 * Нормализация типа события:
 * - Если payload имеет `type` → используется `type`
 * - Если payload имеет `eventName` → используется `eventName`
 * - Если ни одного → выбрасывается ошибка
 *
 * Это позволяет передавать как ExecutionEvent (type), так и DomainEvent (eventName)
 * без необходимости ручного преобразования.
 *
 * @example
 * ```typescript
 * // ExecutionEvent с type
 * const envelope1 = createProductionEnvelope(
 *   { type: 'OrderAccepted', orderId: '123' },
 *   { environment: 'LIVE', accountId: 'main' }
 * );
 *
 * // DomainEvent с eventName
 * const envelope2 = createProductionEnvelope(
 *   { eventName: 'OrderBookSnapshotReceived', tokenId: 'abc' },
 *   { environment: 'LIVE', accountId: 'main' }
 * );
 * ```
 */
export function createProductionEnvelope<E extends { type: string; eventName?: string } | { type?: string; eventName: string }>(
  payload: E,
  executionContext: ExecutionContext,
  correlationId?: string,
  sequenceNumber?: number
): ProductionEnvelope<E> {
  // Нормализация: поддержка type (ExecutionEvent) и eventName (DomainEvent)
  const eventType = payload.type ?? payload.eventName;
  if (!eventType) {
    throw new Error('Payload must have "type" or "eventName" field');
  }

  return {
    id: generateEventId(),
    type: eventType, // EventBus маршрутизирует по этому полю
    payload,
    timestamp: new Date(),
    executionContext,
    correlationId,
    sequenceNumber,
  };
}

/**
 * Создаёт ReplayEnvelope для ExecutionEvent или DomainEvent
 *
 * @param payload - Event payload с type (ExecutionEvent) или eventName (DomainEvent)
 * @param executionContext - Контекст выполнения (environment + accountId)
 * @param sequenceNumber - Порядковый номер (ОБЯЗАТЕЛЕН для replay)
 * @param correlationId - Correlation ID для распределённой трассировки (опционален)
 * @returns ReplayEnvelope<E>
 *
 * @remarks
 * sequenceNumber ОБЯЗАТЕЛЕН (проверка на этапе компиляции)
 *
 * Нормализация типа события:
 * - Если payload имеет `type` → используется `type`
 * - Если payload имеет `eventName` → используется `eventName`
 * - Если ни одного → выбрасывается ошибка
 *
 * @example
 * ```typescript
 * // ExecutionEvent с type
 * const envelope = createReplayEnvelope(
 *   { type: 'OrderAccepted', orderId: '123' },
 *   { environment: 'REPLAY', accountId: 'backtest-2024-01-01' },
 *   42
 * );
 *
 * // DomainEvent с eventName
 * const envelope2 = createReplayEnvelope(
 *   { eventName: 'OrderBookSnapshotReceived', tokenId: 'abc' },
 *   { environment: 'REPLAY', accountId: 'backtest-2024-01-01' },
 *   43
 * );
 * ```
 */
export function createReplayEnvelope<E extends { type: string; eventName?: string } | { type?: string; eventName: string }>(
  payload: E,
  executionContext: ExecutionContext,
  sequenceNumber: number, // ОБЯЗАТЕЛЕН
  correlationId?: string
): ReplayEnvelope<E> {
  // Нормализация: поддержка type (ExecutionEvent) и eventName (DomainEvent)
  const eventType = payload.type ?? payload.eventName;
  if (!eventType) {
    throw new Error('Payload must have "type" or "eventName" field');
  }

  return {
    id: generateEventId(),
    type: eventType,
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
 * - random: base36 строка (7 символов)
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