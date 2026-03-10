/**
 * EventBus — реализация IEventBus с typed HandlerMap.
 *
 * @remarks
 * ### Ключевая особенность — typed HandlerMap:
 * HandlerMap[K] = Set<EventHandler<Extract<ApplicationEvent, { type: K }>>>
 * Это гарантирует, что TypeScript знает точный тип события для каждого handler.
 *
 * ### Правило изоляции handlers (Fix #5 из master-plan):
 * Handlers одного события НЕ должны зависеть от side-effects друг друга.
 * Если Handler A пишет в Portfolio, Handler B не должен читать тот же Portfolio
 * в том же publish(). Если требуется зависимость — Handler A публикует новое событие,
 * Handler B подписывается на него.
 *
 * ### _publishingCount — мониторинг async debt:
 * Node.js event loop однопоточный — физического overflow нет.
 * Счётчик сигнализирует о накопленных незавершённых async handlers.
 * При превышении порога — log warning, не error.
 */
import type { ILogger } from '@polymarket/logger';
import type { ApplicationEvent } from './events/index.js';
import type { IEventBus, EventHandler } from './IEventBus.js';

/**
 * Typed HandlerMap — per-event-type Set<handler>.
 *
 * @remarks
 * TypeScript знает, какой handler соответствует какому event type.
 * Ключевое отличие от Map<string, Set<handler>>: полная типобезопасность.
 */
type HandlerMap = {
  [K in ApplicationEvent['type']]?: Set<EventHandler<Extract<ApplicationEvent, { type: K }>>>;
};

/**
 * Реализация IEventBus с typed dispatch и concurrency monitoring.
 *
 * @example
 * ```typescript
 * const bus = new EventBus(logger);
 *
 * const unsub = bus.subscribe('FILL_RECEIVED', async (event) => {
 *   await fillOrchestrator.handle(event.fill);
 * });
 *
 * await bus.publish({ type: 'FILL_RECEIVED', fill, receivedAt });
 * unsub(); // cleanup
 * ```
 */
export class EventBus implements IEventBus {
  private readonly _handlers: HandlerMap = {};
  private _publishingCount = 0;
  private readonly _maxConcurrentPublish: number;
  private readonly _logger: ILogger;

  /**
   * Создаёт EventBus.
   *
   * @param logger - Logger для диагностики
   * @param maxConcurrentPublish - Порог для warning о высокой нагрузке (по умолчанию 100)
   */
  constructor(logger: ILogger, maxConcurrentPublish = 100) {
    this._logger = logger.child({ component: 'EventBus' });
    this._maxConcurrentPublish = maxConcurrentPublish;
  }

  /**
   * Подписывается на события конкретного типа.
   *
   * @param type - Тип события
   * @param handler - Async handler
   * @returns Функция отписки
   */
  public subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>
  ): () => void {
    if (!this._handlers[type]) {
      (this._handlers as Record<string, unknown>)[type] = new Set();
    }
    const handlers = this._handlers[type]!;
    (handlers as Set<typeof handler>).add(handler);
    return () => (handlers as Set<typeof handler>).delete(handler);
  }

  /**
   * Публикует событие всем подписчикам параллельно (Promise.all fanout).
   *
   * @param event - ApplicationEvent для публикации
   * @remarks
   * Каждый handler изолирован через .catch() — ошибка одного не останавливает других.
   * _publishingCount мониторит async debt — при превышении maxConcurrentPublish логирует warn.
   */
  public async publish(event: ApplicationEvent): Promise<void> {
    this._publishingCount++;
    if (this._publishingCount > this._maxConcurrentPublish) {
      this._logger.warn('EventBus high concurrent publish count', {
        count: this._publishingCount,
        eventType: event.type,
      });
    }
    try {
      const handlers = this._handlers[event.type];
      if (!handlers || handlers.size === 0) return;
      await Promise.all(
        [...handlers].map((handler) =>
          Promise.resolve()
            .then(() => (handler as EventHandler<typeof event>)(event))
            .catch((err: unknown) => {
              this._logger.error('EventBus handler threw an error', {
                err,
                eventType: event.type,
              });
            })
        )
      );
    } finally {
      this._publishingCount--;
    }
  }

  /**
   * Публикует события последовательно (for...of, не Promise.all).
   *
   * @param events - Список событий
   * @remarks
   * Domain events из Order.pullEvents() имеют FSM-порядок:
   * ORDER_CREATED → ORDER_ACCEPTED → ORDER_FILLED
   * Последовательная публикация гарантирует причинно-следственный порядок.
   */
  public async publishAll(events: readonly ApplicationEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }
}
