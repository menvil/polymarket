/**
 * EventBus — реализация IEventBus с queue-based dispatch.
 *
 * @remarks
 * ### Архитектурные свойства:
 *
 * #### 1. Queue-based dispatch (reentrancy-safe)
 * publish() и publishAll() помещают события в очередь (_queue).
 * Если drain уже запущен (_dispatching=true) — просто enqueue и возврат.
 * _drainQueue обрабатывает события в FIFO-порядке до опустошения очереди.
 * Гарантия: publishAll([A,B]) → handler(A) вызывает publish(C) → порядок A→B→C.
 *
 * #### 2. Critical handlers
 * subscribe(type, handler, { critical: true }) — ошибки пробрасываются.
 * Non-critical (по умолчанию) — ошибки логируются, не останавливают других.
 * Critical ошибка: очередь очищается и ошибка пробрасывается.
 * Семантика: critical error = система останавливается, orphaned events дропаются.
 *
 * #### 3. Map-based type safety
 * _handlers: Map<ApplicationEvent['type'], Set<HandlerEntry>>
 * Нет cast через Record<string, unknown> — типобезопасная инициализация.
 *
 * #### 4. Infinite loop guard
 * maxEventsPerDrain ограничивает количество событий за один drain цикл.
 * Защищает от handler(A)→publish(B)→handler(B)→publish(A) петель.
 * При превышении: logger.error + очистка очереди.
 *
 * #### Осознанные trade-offs:
 * - Параллельный fanout (Promise.allSettled): handlers одного события выполняются
 *   одновременно. Нет гарантий порядка если два handlers публикуют дочерние события.
 *   Handlers ОДНОГО события не должны зависеть от side-effects друг друга.
 * - Timeout handlers: не ответственность EventBus. Каждый handler обязан сам
 *   завершаться или обрабатывать собственный timeout.
 */
import type { ILogger } from '@polymarket/logger';
import type { ApplicationEvent } from './events/index.js';
import type { IEventBus, EventHandler } from './IEventBus.js';

/**
 * Запись о подписчике: handler + флаг критичности.
 *
 * @remarks
 * critical=true — ошибки handler пробрасываются из publish(), очередь очищается.
 * critical=false (по умолчанию) — ошибки логируются, не останавливают других handlers.
 */
type HandlerEntry = {
  readonly handler: EventHandler<ApplicationEvent>;
  readonly critical: boolean;
};

/**
 * Реализация IEventBus с queue-based dispatch, critical handlers и Map-based storage.
 *
 * @example
 * ```typescript
 * const bus = new EventBus(logger);
 *
 * // Non-critical (по умолчанию):
 * bus.subscribe('FILL_RECEIVED', async (event) => {
 *   await fillOrchestrator.handle(event.fill);
 * });
 *
 * // Critical — ошибка пробросится из publish(), очередь очистится:
 * bus.subscribe('RISK_LIMIT_BREACHED', riskHandler, { critical: true });
 *
 * await bus.publish({ type: 'FILL_RECEIVED', fill, receivedAt });
 * ```
 */
export class EventBus implements IEventBus {
  private readonly _handlers = new Map<ApplicationEvent['type'], Set<HandlerEntry>>();
  private readonly _queue: ApplicationEvent[] = [];
  private _dispatching = false;
  private readonly _maxEventsPerDrain: number;
  private readonly _logger: ILogger;

  /**
   * Создаёт EventBus.
   *
   * @param logger - Logger для диагностики
   * @param maxEventsPerDrain - Лимит событий за один drain цикл (защита от бесконечных петель).
   *   По умолчанию 10 000.
   */
  constructor(logger: ILogger, maxEventsPerDrain = 10_000) {
    this._logger = logger.child({ component: 'EventBus' });
    this._maxEventsPerDrain = maxEventsPerDrain;
  }

  /**
   * Подписывается на события конкретного типа.
   *
   * @param type - Тип события
   * @param handler - Async handler. Должен завершаться самостоятельно — EventBus не
   *   управляет timeout. Зависший handler заблокирует весь drain цикл.
   * @param options - Опции подписки: { critical?: boolean }
   * @returns Функция отписки. При отписке последнего handler'а — удаляет entry из Map.
   *
   * @remarks
   * critical=true: ошибка handler пробрасывается, очередь очищается.
   * Используется для RISK-событий, нарушение которых = системная остановка.
   */
  public subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>,
    options?: { critical?: boolean },
  ): () => void {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, new Set());
    }
    const entry: HandlerEntry = {
      handler: handler as EventHandler<ApplicationEvent>,
      critical: options?.critical ?? false,
    };
    this._handlers.get(type)!.add(entry);
    return () => {
      const set = this._handlers.get(type);
      if (!set) return;
      set.delete(entry);
      if (set.size === 0) {
        this._handlers.delete(type);
      }
    };
  }

  /**
   * Публикует событие: помещает в очередь и запускает drain если не запущен.
   *
   * @param event - ApplicationEvent для публикации
   * @throws - Если critical handler выбросил исключение (очередь очищена)
   *
   * @remarks
   * Reentrant-safe: если вызывается изнутри handler — событие ставится в очередь,
   * обрабатывается после текущего события, до следующего в publishAll.
   */
  public async publish(event: ApplicationEvent): Promise<void> {
    this._queue.push(event);
    if (this._dispatching) return;
    await this._drainQueue();
  }

  /**
   * Публикует список событий: атомарно помещает все в очередь, запускает drain.
   *
   * @param events - Список событий для последовательной публикации
   * @throws - Если critical handler выбросил исключение (очередь очищена)
   *
   * @remarks
   * Гарантирует порядок: publishAll([A,B]) → handler(A) публикует C → порядок A→B→C.
   * Все события атомарно добавляются в очередь до начала обработки.
   */
  public async publishAll(events: readonly ApplicationEvent[]): Promise<void> {
    for (const event of events) {
      this._queue.push(event);
    }
    if (this._dispatching) return;
    await this._drainQueue();
  }

  /**
   * Последовательно обрабатывает события из очереди до опустошения или лимита.
   *
   * @throws - При critical ошибке handler'а или превышении maxEventsPerDrain.
   *   В обоих случаях: очередь очищается, drain прерывается, ошибка пробрасывается caller'у.
   *
   * @remarks
   * Caller отвечает за обработку ошибки (остановить систему, логировать, etc.).
   * finally гарантирует сброс _dispatching даже при ошибке.
   */
  private async _drainQueue(): Promise<void> {
    this._dispatching = true;
    let processed = 0;
    let drainError: unknown;
    try {
      while (true) {
        const event = this._queue.shift();
        if (!event) break;

        if (processed >= this._maxEventsPerDrain) {
          drainError = new Error(
            `EventBus drain limit exceeded (${this._maxEventsPerDrain}): possible infinite event loop. ` +
              `Remaining events dropped.`,
          );
          break;
        }

        await this._dispatch(event);
        processed++;
      }
    } catch (err) {
      drainError = err;
    } finally {
      // Drain aborted или limit exceeded: очистить оставшиеся события.
      // Caller знает что произошло через rethrow.
      if (drainError !== undefined) this._queue.length = 0;
      this._dispatching = false;
    }
    if (drainError !== undefined) throw drainError;
  }

  /**
   * Вызывает всех подписчиков события параллельно (Promise.allSettled fanout).
   *
   * @param event - Событие для диспетчеризации
   * @throws - Если хотя бы один critical handler выбросил исключение
   *
   * @remarks
   * Все handlers запускаются параллельно — нет гарантий порядка если handlers
   * публикуют дочерние события (они попадут в конец очереди в нондетерминированном порядке).
   * Non-critical ошибки логируются. Critical ошибки: первая пробрасывается после
   * завершения всех handlers (Promise.allSettled дожидается всех).
   */
  private async _dispatch(event: ApplicationEvent): Promise<void> {
    const handlers = this._handlers.get(event.type);
    if (!handlers || handlers.size === 0) return;

    const entries = [...handlers];
    const results = await Promise.allSettled(
      entries.map((entry) => (entry.handler as EventHandler<typeof event>)(event)),
    );

    let firstCriticalError: unknown;
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        const entry = entries[i]!;
        if (entry.critical) {
          firstCriticalError ??= result.reason;
        } else {
          this._logger.error('EventBus handler threw an error', {
            err: result.reason,
            eventType: event.type,
          });
        }
      }
    }

    if (firstCriticalError !== undefined) {
      throw firstCriticalError;
    }
  }
}
