/**
 * InMemoryEventBus - Асинхронная шина событий в памяти (ProductionEventBus)
 *
 * @remarks
 * ProductionEventBus (async, FIFO strict, sequenceNumber ignored)
 *
 * ## Guarantees (BREAKING CHANGE - теперь CONTRACT):
 *
 * ### 1. FIFO strict (ТЕПЕРЬ CONTRACT!)
 * - События обрабатываются в порядке publish() - **ГАРАНТИРОВАНО**
 * - Это БОЛЬШЕ НЕ implementation detail, это **контрактная гарантия**
 * - Subscribers могут полагаться на FIFO порядок
 *
 * ### 2. Async boundary через setImmediate
 * - `publish()` **немедленно возвращает управление**
 * - Handlers вызываются в следующем event loop tick через `setImmediate()`
 * - Producer **никогда не блокируется** на consumers
 *
 * ### 3. Error isolation через try/catch
 * - Каждый handler вызывается в отдельном try/catch
 * - Ошибки **не пробрасываются** в producer
 * - Ошибки передаются в EventBusErrorHandler для логирования
 *
 * ### 4. sequenceNumber IGNORED (КРИТИЧНО)
 * - ProductionEventBus **НЕ сортирует** по sequenceNumber
 * - sequenceNumber - только metadata (для event sourcing persistence)
 * - Порядок определяется ТОЛЬКО publish() order (FIFO)
 *
 * ### 5. Reentrancy protection
 * - Subscriber может вызвать `publish()` внутри handler
 * - Новые события добавляются в очередь, НЕ вызывая рекурсию
 * - Флаг `isDraining` предотвращает множественные drain операции
 * - **Нет stack overflow**
 *
 * @example
 * ```typescript
 * import { ConsoleLogger } from './infrastructure/logging/ConsoleLogger';
 *
 * const logger = new ConsoleLogger();
 * const bus = new InMemoryEventBus(logger);
 *
 * // Подписка на событие ( handler принимает envelope)
 * const unsubscribe = bus.subscribe('OrderAccepted', (envelope) => {
 *   console.log('Order accepted:', envelope.payload.orderId);
 *   console.log('Execution context:', envelope.executionContext);
 * });
 *
 * // Публикация события ( оборачиваем в envelope)
 * const envelope = createProductionEnvelope(
 *   orderAcceptedEvent,
 *   { environment: 'LIVE', accountId: 'main' }
 * );
 * bus.publish(envelope); // Returns immediately
 * // → handler вызовется ПОЗЖЕ (асинхронно, FIFO гарантирован)
 * ```
 */

import type { EventEnvelope } from './EventEnvelope.js';
import type { IEventBus, IEventBusInspector, EventHandler } from './IEventBus.js';
import type { EventBusErrorHandler } from './EventBusErrorHandler.js';
import type { ILogger } from '../../domain/ports/ILogger.js';
import { DefaultEventBusErrorHandler } from './EventBusErrorHandler.js';

/**
 * InMemoryEventBus - Реализация асинхронной шины событий (ProductionEventBus)
 *
 * @remarks
 * implements IEventBus, IEventBusInspector
 *
 * Асинхронная реализация IEventBus с очередью событий и изоляцией ошибок.
 * Создаёт изолированные инстансы (не singleton) для лучшей тестируемости.
 */
export class InMemoryEventBus implements IEventBus, IEventBusInspector {
  /**
   * Handlers для конкретных типов событий
   *
   * @remarks
   * Map: eventName → Array of handlers
   * Array сохраняет порядок подписки.
   */
  private readonly handlers: Map<string, EventHandler[]> = new Map();

  /**
   * Handlers для всех событий
   *
   * @remarks
   * Array сохраняет порядок подписки.
   */
  private readonly allHandlers: EventHandler[] = [];

  /**
   * Очередь событий для асинхронной доставки ( EventEnvelope)
   *
   * @remarks
   * BREAKING CHANGE  queue содержит EventEnvelope<any>, НЕ DomainEvent
   *
   * События добавляются через `publish()` и обрабатываются через `drain()`.
   * FIFO (First In First Out) порядок гарантирован (CONTRACT).
   */
  private readonly queue: EventEnvelope<any>[] = [];

  /**
   * Флаг выполнения drain
   *
   * @remarks
   * Предотвращает множественные одновременные drain операции.
   * Защита от reentrancy: если subscriber вызывает publish(), новое событие
   * добавляется в очередь, а НЕ запускает новый drain.
   */
  private isDraining = false;

  /**
   * Error handler для обработки ошибок в subscribers
   *
   * @remarks
   * Используется для structured logging ошибок через ILogger.
   * По умолчанию: DefaultEventBusErrorHandler (минимальная error policy - только logging).
   */
  private readonly errorHandler: EventBusErrorHandler;

  /**
   * Создаёт InMemoryEventBus
   *
   * @param logger - Logger для логирования ошибок
   * @param errorHandler - Обработчик ошибок (опционально, по умолчанию: DefaultEventBusErrorHandler)
   *
   * @remarks
   * Если errorHandler не передан, создаётся DefaultEventBusErrorHandler с переданным logger.
   * Это обеспечивает минимальную error policy: только logging, никакого retry.
   *
   * @example
   * ```typescript
   * import { ConsoleLogger } from './infrastructure/logging/ConsoleLogger';
   *
   * // С default error handler
   * const logger = new ConsoleLogger();
   * const bus = new InMemoryEventBus(logger);
   *
   * // С custom error handler
   * const customErrorHandler = new CustomErrorHandler(logger);
   * const bus = new InMemoryEventBus(logger, customErrorHandler);
   * ```
   */
  constructor(logger: ILogger, errorHandler?: EventBusErrorHandler) {
    this.errorHandler = errorHandler ?? new DefaultEventBusErrorHandler(logger);
  }

  /**
   * Публикует событие в envelope (( BREAKING CHANGE)
   *
   * @param envelope - EventEnvelope<E>
   *
   * @remarks
   * BREAKING CHANGE  принимает EventEnvelope<E>, НЕ DomainEvent
   *
   * sequenceNumber IGNORED
   * - ProductionEventBus НЕ сортирует по sequenceNumber
   * - Порядок определяется ТОЛЬКО publish() order (FIFO strict - CONTRACT)
   * - sequenceNumber - только metadata
   *
   * **КРИТИЧНО**: Метод **немедленно возвращает управление**.
   * Доставка происходит **асинхронно** через setImmediate().
   *
   * Алгоритм:
   * 1. Добавить envelope в очередь (FIFO)
   * 2. Если drain НЕ выполняется → запустить drain через setImmediate()
   * 3. Немедленно вернуть управление (producer НЕ блокируется)
   *
   * Гарантии:
   * - FIFO strict (CONTRACT)
   * - Producer не блокируется на consumers
   * - Ошибки subscribers не влияют на producer
   * - Безопасно вызывать publish() из handler (reentrancy защищена)
   *
   * @example
   * ```typescript
   * const envelope = createProductionEnvelope(
   *   orderAcceptedEvent,
   *   { environment: 'LIVE', accountId: 'main' }
   * );
   *
   * bus.publish(envelope);
   * console.log('returned immediately');
   * // → handlers вызовутся ПОЗЖЕ (в следующем event loop tick, FIFO порядок)
   * ```
   */
  public publish<E = any>(envelope: EventEnvelope<E>): void {
    // sequenceNumber IGNORED (NO sorting)
    // 1. Добавить envelope в очередь (FIFO)
    this.queue.push(envelope as EventEnvelope<any>);

    // 2. Если drain НЕ выполняется → запустить drain
    if (!this.isDraining) {
      this.scheduleDrain();
    }

    // 3. Немедленно вернуть управление (producer НЕ блокируется!)
  }

  /**
   * Планирует drain операцию через setImmediate()
   *
   * @remarks
   * Использует setImmediate() для асинхронной доставки в следующем event loop tick.
   * Это создаёт **async boundary** между producer и consumer.
   */
  private scheduleDrain(): void {
    setImmediate(() => {
      this.drain();
    });
  }

  /**
   * Обрабатывает очередь событий
   *
   * @remarks
   * Алгоритм (O(n) оптимизация):
   * 1. Установить флаг isDraining = true (защита от reentrancy)
   * 2. Итерировать по индексу: while (i < queue.length)
   * 3. Один splice(0, i) в конце для удаления обработанных событий
   * 4. Сбросить флаг isDraining = false
   *
   * Оптимизация:
   * - Старый подход: shift() в цикле → O(n²) (shift = O(n) на каждый вызов)
   * - Новый подход: индекс + один splice → O(n)
   *
   * ВАЖНО: Subscriber может вызвать publish() внутри обработки.
   * Новое событие добавится в this.queue, queue.length увеличится,
   * и цикл продолжит обработку. isDraining = true предотвращает
   * запуск нового drain.
   *
   * Гарантии:
   * - События обрабатываются строго FIFO
   * - Нет stack overflow при reentrancy
   * - Нет одновременных drain операций
   */
  private drain(): void {
    // Установить флаг drain (защита от reentrancy)
    this.isDraining = true;

    try {
      // O(n) оптимизация: вместо shift() O(n) на каждый элемент,
      // итерируем по индексу и делаем один splice в конце
      // Если handler вызывает publish(), queue.length растёт и цикл продолжается
      let i = 0;
      while (i < this.queue.length) {
        const event = this.queue[i++];
        this.deliverEvent(event);
      }
      // Удалить обработанные события одной операцией splice
      if (i > 0) {
        this.queue.splice(0, i);
      }
    } finally {
      // Сбросить флаг drain (даже если была ошибка)
      this.isDraining = false;
    }
  }

  /**
   * Доставляет событие всем subscribers (( BREAKING CHANGE)
   *
   * @param envelope - EventEnvelope для доставки
   *
   * @remarks
   * BREAKING CHANGE  принимает EventEnvelope, НЕ DomainEvent
   *
   * Маршрутизация по envelope.type, payload opaque
   * - EventBus читает ТОЛЬКО envelope.type для routing
   * - EventBus НЕ читает payload (payload opaque)
   * - Handlers получают полный envelope (с metadata: timestamp, executionContext, sequenceNumber)
   *
   * Алгоритм:
   * 1. Вызвать specific event handlers (для envelope.type)
   * 2. Вызвать "all events" handlers (subscribeAll)
   * 3. Ошибки в handlers изолированы (try/catch per handler)
   *
   * **ВАЖНО**: Порядок вызова handlers (specific → all) - это implementation detail.
   * Контракт IEventBus НЕ гарантирует этот порядок.
   */
  private deliverEvent(envelope: EventEnvelope<any>): void {
    // Маршрутизация по envelope.type, NOT payload
    const eventName = envelope.type;

    // 1. Вызвать specific event handlers
    // ВАЖНО: Shallow copy для защиты от мутации при unsubscribe во время dispatch
    // Если handler отписывается во время итерации, splice() сдвигает элементы и
    // for...of может пропустить следующий handler
    const specificHandlers = this.handlers.get(eventName);
    if (specificHandlers) {
      for (const handler of [...specificHandlers]) {
        this.invokeHandler(handler, envelope, 'specific');
      }
    }

    // 2. Вызвать "all events" handlers
    // ВАЖНО: Shallow copy для защиты от мутации при unsubscribe во время dispatch
    for (const handler of [...this.allHandlers]) {
      this.invokeHandler(handler, envelope, 'all');
    }
  }

  /**
   * Вызывает handler с изоляцией ошибок (( BREAKING CHANGE)
   *
   * @param handler - Handler для вызова
   * @param envelope - EventEnvelope для передачи в handler
   * @param handlerType - Тип handler ('specific' или 'all') для debugging
   *
   * @remarks
   * BREAKING CHANGE  передаёт EventEnvelope, НЕ DomainEvent
   *
   * Оборачивает вызов handler в try/catch.
   * Ошибки передаются в EventBusErrorHandler для structured logging.
   * Это гарантирует что один сломанный handler не сломает другие.
   */
  private invokeHandler(
    handler: EventHandler,
    envelope: EventEnvelope<any>,
    handlerType: 'specific' | 'all'
  ): void {
    try {
      //  Handler принимает envelope, NOT payload
      handler(envelope);
    } catch (error) {
      // Передать ошибку в error handler (НЕ пробрасывать!)
      try {
        this.errorHandler.handle(error, envelope, handlerType);
      } catch (errorHandlerError) {
        // Fallback: если даже error handler упал
        console.error('[EventBus] Error in error handler:', errorHandlerError);
        console.error('[EventBus] Original error:', error);
        console.error('[EventBus] Event type:', envelope.type, 'id:', envelope.id);
      }
    }
  }

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
   * const unsubscribe = bus.subscribe('TradeExecuted', (event) => {
   *   console.log('Trade:', event.price, event.size);
   * });
   *
   * // Позже: отписка
   * unsubscribe();
   * ```
   */
  public subscribe(eventName: string, handler: EventHandler): () => void {
    // Получить или создать массив handlers для этого события
    let eventHandlers = this.handlers.get(eventName);
    if (!eventHandlers) {
      eventHandlers = [];
      this.handlers.set(eventName, eventHandlers);
    }

    // Добавить handler в массив (сохраняет порядок)
    eventHandlers.push(handler);

    // Вернуть функцию отписки
    return () => {
      const handlers = this.handlers.get(eventName);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index !== -1) {
          handlers.splice(index, 1);
        }

        // Очистить пустые массивы
        if (handlers.length === 0) {
          this.handlers.delete(eventName);
        }
      }
    };
  }

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
   * const unsubscribe = bus.subscribeAll((event) => {
   *   console.log('Any event:', event.eventName, event.timestamp);
   * });
   *
   * // Позже: отписка
   * unsubscribe();
   * ```
   */
  public subscribeAll(handler: EventHandler): () => void {
    // Добавить handler в массив allHandlers (сохраняет порядок)
    this.allHandlers.push(handler);

    // Вернуть функцию отписки
    return () => {
      const index = this.allHandlers.indexOf(handler);
      if (index !== -1) {
        this.allHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Получает количество подписчиков для конкретного события
   *
   * @param eventName - Имя события для проверки
   * @returns Количество handlers подписанных на это событие
   *
   * @remarks
   * Утилитный метод для тестирования и отладки.
   *
   * @example
   * ```typescript
   * const count = bus.getSubscriberCount('TradeExecuted');
   * console.log(`${count} handlers for TradeExecuted`);
   * ```
   */
  public getSubscriberCount(eventName: string): number {
    const handlers = this.handlers.get(eventName);
    return handlers ? handlers.length : 0;
  }

  /**
   * Получает количество подписчиков на все события
   *
   * @returns Количество handlers подписанных на все события
   *
   * @remarks
   * Утилитный метод для тестирования и отладки.
   *
   * @example
   * ```typescript
   * const count = bus.getAllSubscriberCount();
   * console.log(`${count} handlers for all events`);
   * ```
   */
  public getAllSubscriberCount(): number {
    return this.allHandlers.length;
  }

  /**
   * Очищает все подписки
   *
   * @remarks
   * Удаляет все handlers (как specific, так и "all events").
   * Утилитный метод для cleanup в тестах.
   *
   * ВАЖНО: Не очищает очередь событий! События в очереди будут доставлены.
   *
   * @example
   * ```typescript
   * // После тестов
   * bus.clear();
   * ```
   */
  public clear(): void {
    this.handlers.clear();
    this.allHandlers.length = 0;
  }

  /**
   * Получает статистику EventBus (IEventBusInspector)
   *
   * @returns Статистика (queueSize, isDraining)
   *
   * @remarks
   * для IEventBusInspector (testing/debugging)
   *
   * Используется для:
   * - Тестов: проверить что очередь пуста после drain
   * - Debugging: узнать текущий размер очереди
   * - Monitoring: отследить перегрузку EventBus
   *
   * @example
   * ```typescript
   * const stats = bus.getStats();
   * console.log('Queue size:', stats.queueSize);
   * console.log('Is draining:', stats.isDraining);
   * ```
   */
  public getStats(): { queueSize: number; isDraining: boolean } {
    return {
      queueSize: this.queue.length,
      isDraining: this.isDraining,
    };
  }

}
