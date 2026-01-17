/**
 * IEventBus - Интерфейс шины событий (( BREAKING CHANGE)
 *
 * @remarks
 * TWO IMPLEMENTATIONS (ProductionEventBus vs ReplayEventBus)
 *
 * ## Контракт EventBus (ProductionEventBus vs ReplayEventBus):
 *
 * ### ProductionEventBus guarantees:
 * - **FIFO strict**: события обрабатываются в порядке publish() (теперь это CONTRACT)
 * - **Async boundary**: publish() возвращается немедленно (setImmediate)
 * - **Error isolation**: ошибка в handler не влияет на другие handlers
 * - **sequenceNumber IGNORED**: ProductionEventBus НЕ сортирует, sequenceNumber только metadata
 *
 * ### ReplayEventBus guarantees:
 * - **sequenceNumber SORTED**: события сортируются строго по sequenceNumber
 * - **Synchronous**: publish() обрабатывает handlers синхронно (NO setImmediate)
 * - **Deterministic**: replay всегда воспроизводится одинаково
 * - **sequenceNumber REQUIRED**: все события ДОЛЖНЫ иметь sequenceNumber
 *
 * ProductionEventBus и ReplayEventBus - РАЗНЫЕ реализации
 * - ProductionEventBus: InMemoryEventBus (async, FIFO, sequenceNumber ignored)
 * - ReplayEventBus: SequencedEventBus (sync, sorted, sequenceNumber required)
 *
 * Почему разделение:
 * - Нельзя быть И FIFO И sorted (логическое противоречие)
 * - Production = performance (async, FIFO)
 * - Replay = determinism (sync, sorted)
 *
 * ## Контракт EventBus (общие гарантии):
 *
 * ### 1. Error isolation (изоляция ошибок)
 * - Ошибка в одном handler **НЕ влияет** на другие handlers
 * - Ошибки **НЕ пробрасываются** в producer
 * - Ошибки **передаются в EventBusErrorHandler** для логирования (ProductionEventBus only)
 *
 * ### 2. Best-effort delivery (доставка "на лучших условиях")
 * - EventBus **делает попытку вызвать** каждый handler один раз
 * - Если handler бросает ошибку - попытка считается выполненной
 * - **НЕТ автоматических retry** (повторов)
 *
 * ### 3. Idempotency requirement (требование идемпотентности)
 * - Subscribers **ДОЛЖНЫ быть idempotent**
 * - Handler может быть вызван повторно (при будущих retry/replay механизмах)
 * - Handler должен корректно обрабатывать дубликаты событий
 *
 * ### 4. No reentrancy issues (защита от reentrancy)
 * - Subscriber может вызвать `publish()` внутри handler
 * - **НЕТ stack overflow** при вложенных `publish()`
 * - Реализация должна предотвращать бесконечную рекурсию
 *
 * @example
 * ```typescript
 * // ProductionEventBus (async, FIFO)
 * const productionBus: IEventBus = new InMemoryEventBus(logger);
 *
 * productionBus.subscribe('OrderAccepted', (envelope) => {
 *   console.log('Order accepted:', envelope.payload.orderId);
 * });
 *
 * const envelope = createProductionEnvelope(orderAcceptedEvent, executionContext);
 * productionBus.publish(envelope); // Returns immediately, handler called async
 *
 * // ReplayEventBus (sync, sorted)
 * const replayBus: IEventBus = new SequencedEventBus();
 *
 * replayBus.subscribe('OrderAccepted', (envelope) => {
 *   console.log('Order accepted (replay):', envelope.payload.orderId);
 * });
 *
 * const replayEnvelope = createReplayEnvelope(orderAcceptedEvent, executionContext, 42);
 * replayBus.publish(replayEnvelope); // Handler called synchronously
 * ```
 */

import type { EventEnvelope } from './EventEnvelope.js';

/**
 * Event handler function (( generic, NOT "extends DomainEvent")
 *
 * @remarks
 * НЕ "extends DomainEvent"
 *
 * Почему generic <T>:
 * - ExecutionEvent НЕ DomainEvent (infrastructure → domain boundary event)
 * - ExecutionErrorEvent НЕ DomainEvent (execution error)
 * - DomainEvent = business facts (domain logic)
 * - EventBus должен работать со ВСЕМИ типами событий
 *
 * Handler принимает EventEnvelope<T>, НЕ голый payload:
 * - Envelope содержит metadata (timestamp, executionContext, sequenceNumber)
 * - Payload opaque (EventBus не читает payload, только доставляет)
 *
 * ВАЖНО: Handler должен быть **idempotent** (переживёт повторную доставку).
 *
 * @template T - Тип события payload (generic, НЕ "extends DomainEvent")
 */
export type EventHandler<T = any> = (envelope: EventEnvelope<T>) => void;

/**
 * IEventBus - Интерфейс шины событий
 *
 * @remarks
 * generic <E = any>, НЕ "extends DomainEvent"
 */
export interface IEventBus {
  /**
   * Публикует событие в envelope
   *
   * @param envelope - EventEnvelope<E>
   *
   * @remarks
   * BREAKING CHANGE  Теперь принимает EventEnvelope<E> (generic), НЕ "extends DomainEvent"
   *
   * Почему НЕ "extends DomainEvent":
   * - ExecutionEvent НЕ DomainEvent (infrastructure → domain boundary)
   * - ExecutionErrorEvent НЕ DomainEvent (execution error)
   * - EventBus должен работать со ВСЕМИ типами событий
   *
   * Routing: EventBus маршрутизирует по envelope.type, НЕ по payload
   *
   * Ordering guarantee:
   * - ProductionEventBus: FIFO для одного source, sequenceNumber ignored
   * - ReplayEventBus: sequenceNumber sorted, FIFO не гарантирован
   *
   * @example
   * ```typescript
   * // ProductionEventBus (async, FIFO)
   * const envelope = createProductionEnvelope(
   *   orderAcceptedEvent,
   *   { environment: 'LIVE', accountId: 'main' }
   * );
   * productionBus.publish(envelope); // Returns immediately
   *
   * // ReplayEventBus (sync, sorted)
   * const replayEnvelope = createReplayEnvelope(
   *   orderAcceptedEvent,
   *   { environment: 'REPLAY', accountId: 'backtest' },
   *   42 // sequenceNumber REQUIRED
   * );
   * replayBus.publish(replayEnvelope); // Handler called synchronously
   * ```
   */
  publish<E = any>(envelope: EventEnvelope<E>): void;

  /**
   * Подписывается на конкретный тип события
   *
   * @param eventName - Имя события для подписки (например, 'OrderBookSnapshotReceived')
   * @param handler - Handler для вызова при публикации события
   * @returns Функция отписки
   *
   * @remarks
   * Handler добавляется в конец массива (сохраняет порядок подписки).
   * Множественные подписки с одним handler разрешены (каждая получает отдельный unsubscribe).
   *
   * @example
   * ```typescript
   * const unsubscribe = bus.subscribe('TradeExecuted', (envelope) => {
   *   // envelope.type = 'TradeExecuted'
   *   // envelope.payload = TradeExecutedEvent
   *   console.log('Trade:', envelope.payload.price, envelope.payload.size);
   *   console.log('Timestamp:', envelope.timestamp);
   * });
   *
   * // Позже: отписка
   * unsubscribe();
   * ```
   */
  subscribe(eventName: string, handler: EventHandler): () => void;

  /**
   * Подписывается на все события
   *
   * @param handler - Handler для вызова при любом опубликованном событии
   * @returns Функция отписки
   *
   * @remarks
   * Handler вызывается для КАЖДОГО события, независимо от eventName.
   * Полезно для логирования, мониторинга или сбора данных.
   *
   * @example
   * ```typescript
   * const unsubscribe = bus.subscribeAll((envelope) => {
   *   // envelope.type = тип события (маршрутизация)
   *   // envelope.payload = данные события
   *   // envelope.timestamp = время события
   *   console.log('Event:', envelope.type, envelope.timestamp);
   *   console.log('Context:', envelope.executionContext.environment);
   * });
   *
   * // Позже: отписка
   * unsubscribe();
   * ```
   */
  subscribeAll(handler: EventHandler): () => void;

  /**
   * Получает количество подписчиков для конкретного события
   *
   * @param eventName - Имя события для проверки
   * @returns Количество handlers подписанных на это событие
   *
   * @remarks
   * Утилитный метод для тестирования и отладки.
   */
  getSubscriberCount(eventName: string): number;

  /**
   * Получает количество подписчиков на все события
   *
   * @returns Количество handlers подписанных на все события
   *
   * @remarks
   * Утилитный метод для тестирования и отладки.
   */
  getAllSubscriberCount(): number;
}

/**
 * IEventBusInspector - интерфейс для тестирования и отладки EventBus
 *
 * @remarks
 * вынесено из IEventBus для clean separation
 *
 * Эти методы НЕ должны использоваться в production коде.
 * Только для тестов и debugging.
 */
export interface IEventBusInspector {
  /**
   * Очищает все подписки
   *
   * @remarks
   * Удаляет все handlers (как specific, так и "all events").
   * Утилитный метод для cleanup в тестах.
   */
  clear(): void;

  /**
   * Получает статистику EventBus
   *
   * @returns Статистика (queue size, isDraining)
   *
   * @remarks
   * Для InMemoryEventBus (ProductionEventBus):
   * - queueSize: количество событий в очереди
   * - isDraining: обрабатывается ли очередь сейчас
   *
   * Для SequencedEventBus (ReplayEventBus):
   * - queueSize: always 0 (synchronous)
   * - isDraining: always false
   */
  getStats(): {
    queueSize: number;
    isDraining: boolean;
  };
}
