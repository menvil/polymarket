/**
 * Конверт события с контекстом.
 *
 * @remarks
 * Оборачивает событие с метаданными (контекст, timestamp).
 * В Phase 2 будет заменён на EventEnvelope из @polymarket/event-bus.
 */
import type { ExecutionContext } from './ExecutionContext.js';

/** Конверт события с контекстом и timestamp */
export interface EventEnvelope<T = unknown> {
  event: T;
  context: ExecutionContext;
  timestamp: Date;
}

/**
 * Создаёт конверт события для production-среды.
 *
 * @param event - Событие для оборачивания
 * @param context - Контекст исполнения
 * @returns Конверт события
 *
 * @example
 * ```typescript
 * const envelope = createProductionEnvelope(orderAcceptedEvent, { environment: 'LIVE', accountId: '0x...' });
 * eventBus.publish(envelope);
 * ```
 */
export function createProductionEnvelope<T>(
  event: T,
  context: ExecutionContext
): EventEnvelope<T> {
  return {
    event,
    context,
    timestamp: new Date(),
  };
}
