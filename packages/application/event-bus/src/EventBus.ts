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
 * Critical ошибка: drain прерывается, ошибка пробрасывается caller'у.
 * Очередь НЕ очищается — события легитимны, следующий publish() возобновит drain.
 * Bus остаётся работоспособным. Caller решает: перезапустить, остановить систему, alerting.
 *
 * #### 3. Map-based type safety
 * _handlers: Map<ApplicationEvent['type'], Set<HandlerEntry>>
 * Нет cast через Record<string, unknown> — типобезопасная инициализация.
 *
 * #### 4. Infinite loop guard
 * maxEventsPerDrain ограничивает количество событий за один drain цикл.
 * Защищает от handler(A)→publish(B)→handler(B)→publish(A) петель.
 * При превышении: throw + очистка очереди (события — артефакт бага, не легитимные данные).
 *
 * #### 5. Queue overflow guard
 * maxQueueSize ограничивает размер очереди.
 * publish()/publishAll() бросают ошибку если лимит превышен.
 * Защищает от OOM при медленном drain и высокочастотных событиях.
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
 * critical=true — ошибки handler пробрасываются из publish(), drain прерывается.
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
 * // Critical — drain прерывается, bus остаётся работоспособным:
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
  private readonly _maxQueueSize: number;
  private readonly _logger: ILogger;

  /**
   * Создаёт EventBus.
   *
   * @param logger - Logger для диагностики
   * @param maxEventsPerDrain - Лимит событий за один drain цикл (защита от infinite loops).
   *   По умолчанию 10 000. При превышении: throw + очистка очереди.
   * @param maxQueueSize - Максимальный размер очереди (защита от OOM).
   *   По умолчанию 100 000. publish()/publishAll() бросают если лимит превышен.
   */
  constructor(logger: ILogger, maxEventsPerDrain = 10_000, maxQueueSize = 100_000) {
    this._logger = logger.child({ component: 'EventBus' });
    this._maxEventsPerDrain = maxEventsPerDrain;
    this._maxQueueSize = maxQueueSize;
  }

  /**
   * Возвращает диагностические метрики bus'а.
   *
   * @returns Снимок текущего состояния: размер очереди, количество типов событий с подписчиками, флаг активного drain.
   *
   * @remarks
   * Используется для мониторинга и debugging в production.
   * Вызывать периодически или при подозрении на зависание drain.
   *
   * @example
   * ```typescript
   * setInterval(() => {
   *   const stats = bus.getStats();
   *   if (stats.queueSize > 1000) logger.warn('EventBus queue growing', stats);
   * }, 5000);
   * ```
   */
  public getStats(): { queueSize: number; subscribedTypes: number; dispatching: boolean } {
    return {
      queueSize: this._queue.length,
      subscribedTypes: this._handlers.size,
      dispatching: this._dispatching,
    };
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
   * critical=true: ошибка handler пробрасывается, drain прерывается.
   * Используется для RISK-событий, нарушение которых требует немедленной реакции caller'а.
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
   * @throws - Если очередь переполнена (maxQueueSize) или critical handler выбросил исключение
   *
   * @remarks
   * Reentrant-safe: если вызывается изнутри handler — событие ставится в очередь,
   * обрабатывается после текущего события, до следующего в publishAll.
   */
  public async publish(event: ApplicationEvent): Promise<void> {
    if (this._queue.length + 1 > this._maxQueueSize) {
      throw new Error(
        `EventBus queue overflow (${this._maxQueueSize}): cannot enqueue ${event.type}`,
      );
    }
    this._queue.push(event);
    if (this._dispatching) return;
    await this._drainQueue();
  }

  /**
   * Публикует список событий: помещает все в очередь синхронно, запускает drain.
   *
   * @param events - Список событий для последовательной публикации
   * @throws - Если очередь переполнена (maxQueueSize) или critical handler выбросил исключение
   *
   * @remarks
   * Гарантирует порядок: publishAll([A,B]) → handler(A) публикует C → порядок A→B→C.
   * Все события проверяются на overflow и добавляются в очередь в одном синхронном цикле
   * до запуска drain — interleave с другими событиями невозможен.
   */
  public async publishAll(events: readonly ApplicationEvent[]): Promise<void> {
    if (this._queue.length + events.length > this._maxQueueSize) {
      throw new Error(
        `EventBus queue overflow (${this._maxQueueSize}): cannot enqueue ${events.length} events`,
      );
    }
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
   *
   * @remarks
   * ### Политика очистки очереди при ошибке:
   * - Critical handler failure: очередь НЕ очищается. События легитимны,
   *   следующий publish() возобновит drain. Bus остаётся работоспособным.
   * - Drain limit exceeded: очередь ОЧИЩАЕТСЯ. События — артефакт infinite loop,
   *   не легитимные данные. Повторная обработка только усугубит проблему.
   *
   * finally гарантирует сброс _dispatching даже при ошибке.
   */
  private async _drainQueue(): Promise<void> {
    this._dispatching = true;
    let processed = 0;
    let drainError: unknown;
    let drainLimitExceeded = false;
    try {
      while (true) {
        const event = this._queue.shift();
        if (!event) break;

        if (processed >= this._maxEventsPerDrain) {
          drainLimitExceeded = true;
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
      // Critical handler failure: сохраняем ошибку, очередь НЕ очищаем.
      drainError = err;
    } finally {
      // Drain limit: очистить артефакты infinite loop.
      // Critical failure: оставить очередь нетронутой.
      if (drainLimitExceeded) this._queue.length = 0;
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
      entries.map((entry) => entry.handler(event)),
    );

    // Boolean flag + separate storage: обходит ограничения TypeScript narrowing через ??=.
    let hasCriticalError = false;
    let criticalError: unknown = undefined;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status !== 'rejected') continue;
      const entry = entries[i];
      if (entry.critical) {
        if (!hasCriticalError) {
          hasCriticalError = true;
          criticalError = result.reason;
        } else {
          // Последующие critical ошибки: логируем, не теряем
          this._logger.error('EventBus critical handler threw an additional error', {
            err: result.reason,
            eventType: event.type,
          });
        }
      } else {
        this._logger.error('EventBus handler threw an error', {
          err: result.reason,
          eventType: event.type,
        });
      }
    }

    if (hasCriticalError) throw criticalError;
  }
}
