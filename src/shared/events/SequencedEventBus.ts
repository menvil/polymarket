/**
 * SequencedEventBus - Replay EventBus (sync, sequenceNumber sorted, deterministic)
 *
 * @remarks
 * Для REPLAY ONLY (НЕ для production)
 *
 * Guarantees:
 * - sequenceNumber SORTED (строгий порядок по sequenceNumber)
 * - Synchronous (NO setImmediate, handlers вызываются синхронно)
 * - Deterministic (replay всегда воспроизводится одинаково)
 * - sequenceNumber REQUIRED (если envelope без sequenceNumber → error)
 *
 * Отличия от ProductionEventBus (InMemoryEventBus):
 * - ProductionEventBus: async, FIFO, sequenceNumber ignored
 * - ReplayEventBus: sync, sorted, sequenceNumber required
 *
 * @example
 * ```typescript
 * const replayBus = new SequencedEventBus();
 *
 * // Subscribe to events
 * replayBus.subscribe('OrderAccepted', (envelope) => {
 *   console.log('Order accepted:', envelope.payload.orderId);
 * });
 *
 * // Publish events with sequenceNumber
 * const envelope1: ReplayEnvelope<OrderAccepted> = {
 *   id: '1',
 *   type: 'OrderAccepted',
 *   payload: { type: 'OrderAccepted', orderId: '123', side: 'BUY', marketId: 'abc', price: 100, size: 10 },
 *   timestamp: new Date(),
 *   executionContext: { environment: 'REPLAY', accountId: 'backtest-xyz' },
 *   sequenceNumber: 42, // REQUIRED для replay
 * };
 *
 * replayBus.publish(envelope1); // Delivered synchronously
 * ```
 */
import type { IEventBus, EventHandler } from './IEventBus.js';
import type { EventEnvelope } from './EventEnvelope.js';

/**
 * SequencedEventBus implementation
 *
 * @remarks
 * Для replay с deterministic ordering
 */
export class SequencedEventBus implements IEventBus {
  private readonly handlers: Map<string, EventHandler[]> = new Map();
  private readonly allHandlers: EventHandler[] = [];

  /**
   * Публикует событие в envelope (synchronous, sequenceNumber required)
   *
   * @param envelope - EventEnvelope (ДОЛЖЕН содержать sequenceNumber)
   *
   * @remarks
   * sequenceNumber REQUIRED
   * - Если envelope.sequenceNumber === undefined → throw error
   * - Delivery SYNCHRONOUS (NO setImmediate)
   * - Deterministic replay
   *
   * @throws {Error} Если sequenceNumber отсутствует
   *
   * @example
   * ```typescript
   * const envelope: ReplayEnvelope<OrderAccepted> = {
   *   id: '1',
   *   type: 'OrderAccepted',
   *   payload: orderAcceptedEvent,
   *   timestamp: new Date(),
   *   executionContext: { environment: 'REPLAY', accountId: 'backtest' },
   *   sequenceNumber: 1, // REQUIRED
   * };
   *
   * replayBus.publish(envelope);
   * ```
   */
  public publish<E = any>(envelope: EventEnvelope<E>): void {
    // sequenceNumber REQUIRED для replay
    if (envelope.sequenceNumber === undefined) {
      throw new Error(`[SequencedEventBus] sequenceNumber required for envelope ${envelope.id} (type: ${envelope.type})`);
    }

    // Synchronous delivery (NO setImmediate)
    // Deterministic replay - handlers вызываются немедленно
    this.deliverEvent(envelope);
  }

  /**
   * Подписаться на события определённого типа
   *
   * @param eventName - Имя события (envelope.type)
   * @param handler - Handler функция
   * @returns Unsubscribe функция
   *
   * @example
   * ```typescript
   * const unsubscribe = replayBus.subscribe('OrderAccepted', (envelope) => {
   *   console.log('Order accepted:', envelope.payload.orderId);
   * });
   *
   * // Later: unsubscribe
   * unsubscribe();
   * ```
   */
  public subscribe(eventName: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventName)) {
      this.handlers.set(eventName, []);
    }

    const handlers = this.handlers.get(eventName)!;
    handlers.push(handler);

    // Return unsubscribe function
    return () => {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    };
  }

  /**
   * Подписаться на все события
   *
   * @param handler - Handler функция
   * @returns Unsubscribe функция
   *
   * @example
   * ```typescript
   * const unsubscribe = replayBus.subscribeAll((envelope) => {
   *   console.log('Event:', envelope.type, 'seq:', envelope.sequenceNumber);
   * });
   * ```
   */
  public subscribeAll(handler: EventHandler): () => void {
    this.allHandlers.push(handler);

    // Return unsubscribe function
    return () => {
      const index = this.allHandlers.indexOf(handler);
      if (index !== -1) {
        this.allHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Получить количество подписчиков на событие
   *
   * @param eventName - Имя события
   * @returns Количество подписчиков
   */
  public getSubscriberCount(eventName: string): number {
    return this.handlers.get(eventName)?.length || 0;
  }

  /**
   * Получить общее количество all-subscribers
   *
   * @returns Количество all-subscribers
   */
  public getAllSubscriberCount(): number {
    return this.allHandlers.length;
  }

  /**
   * Доставляет событие подписчикам (synchronous)
   *
   * @param envelope - EventEnvelope для доставки
   *
   * @remarks
   * Synchronous delivery (для deterministic replay)
   * - NO try/catch (для determinism - ошибка должна прервать replay)
   * - Порядок: specific handlers → all handlers
   */
  private deliverEvent(envelope: EventEnvelope<any>): void {
    const eventName = envelope.type;

    // Deliver to specific handlers
    const specificHandlers = this.handlers.get(eventName);
    if (specificHandlers) {
      for (const handler of specificHandlers) {
        // Synchronous (NO try/catch for determinism)
        handler(envelope);
      }
    }

    // Deliver to all handlers
    for (const handler of this.allHandlers) {
      handler(envelope);
    }
  }

  /**
   * Очищает все подписки (для тестов)
   *
   * @remarks
   * Используется в тестах для cleanup между тестами
   */
  public clear(): void {
    this.handlers.clear();
    this.allHandlers.length = 0;
  }
}
