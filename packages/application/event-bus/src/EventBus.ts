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
 * subscribe(type, handler, { critical: true }) — ошибки возвращаются как
 * Err(CriticalHandlerError) из publish()/publishAll() (бросаются из
 * publishOrThrow()/publishAllOrThrow()).
 * Non-critical (по умолчанию) — ошибки логируются, не останавливают других.
 * Critical ошибка: drain прерывается, ошибка возвращается/пробрасывается caller'у.
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
 * При превышении: Err(QueueOverflowError) + очистка очереди (события — артефакт бага,
 * не легитимные данные).
 *
 * #### 5. Queue overflow guard
 * maxQueueSize ограничивает размер очереди.
 * publish()/publishAll() возвращают Err(QueueOverflowError) если лимит превышен.
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
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { QueueOverflowError, CriticalHandlerError } from '@polymarket/errors/event-bus';
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
 * const result = await bus.publish({ type: 'FILL_RECEIVED', fill, receivedAt });
 * if (!result.ok) logger.error('Publish failed', { error: result.error.message });
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
   *   По умолчанию 10 000. При превышении: Err(QueueOverflowError) + очистка очереди.
   * @param maxQueueSize - Максимальный размер очереди (защита от OOM).
   *   По умолчанию 100 000. publish()/publishAll() возвращают Err(QueueOverflowError)
   *   если лимит превышен.
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
   * critical=true: ошибка handler возвращается как Err(CriticalHandlerError), drain
   * прерывается. Используется для RISK-событий, нарушение которых требует немедленной
   * реакции caller'а.
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
   * @returns `Ok(void)`, либо `Err(QueueOverflowError)` при переполнении очереди/лимита
   *   drain-цикла, либо `Err(CriticalHandlerError)` если critical-подписчик бросил
   *
   * @remarks
   * Reentrant-safe: если вызывается изнутри handler — событие ставится в очередь,
   * обрабатывается после текущего события, до следующего в publishAll.
   *
   * `_drainQueue()`/`_dispatch()` остаются throw-based внутри (private, не пересекают
   * публичную границу) — `try/catch` здесь конвертирует в `Result`: `QueueOverflowError`
   * пробрасывается как есть (её уже сконструировал `_drainQueue()` для drain-limit),
   * что угодно ещё (raw throw из critical-подписчика через `_dispatch()`) оборачивается
   * в `CriticalHandlerError`.
   */
  public async publish(event: ApplicationEvent): Promise<Result<void, QueueOverflowError | CriticalHandlerError>> {
    if (this._queue.length + 1 > this._maxQueueSize) {
      return Err(new QueueOverflowError(
        `EventBus queue overflow (${this._maxQueueSize}): cannot enqueue ${event.type}`,
        { context: { maxQueueSize: this._maxQueueSize, eventType: event.type } },
      ));
    }
    this._queue.push(event);
    if (this._dispatching) return Ok(undefined);
    return this._drainAndConvert();
  }

  /**
   * Публикует список событий: помещает все в очередь синхронно, запускает drain.
   *
   * @param events - Список событий для последовательной публикации
   * @returns См. {@link EventBus.publish}
   *
   * @remarks
   * Гарантирует порядок: publishAll([A,B]) → handler(A) публикует C → порядок A→B→C.
   * Все события проверяются на overflow и добавляются в очередь в одном синхронном цикле
   * до запуска drain — interleave с другими событиями невозможен.
   */
  public async publishAll(events: readonly ApplicationEvent[]): Promise<Result<void, QueueOverflowError | CriticalHandlerError>> {
    if (this._queue.length + events.length > this._maxQueueSize) {
      return Err(new QueueOverflowError(
        `EventBus queue overflow (${this._maxQueueSize}): cannot enqueue ${events.length} events`,
        { context: { maxQueueSize: this._maxQueueSize, eventCount: events.length } },
      ));
    }
    for (const event of events) {
      this._queue.push(event);
    }
    if (this._dispatching) return Ok(undefined);
    return this._drainAndConvert();
  }

  /**
   * Публикует событие; бросает вместо возврата `Err` (deprecation-мост, см. {@link IEventBus.publishOrThrow}).
   *
   * @param event - ApplicationEvent для публикации
   * @throws {QueueOverflowError | CriticalHandlerError} См. `publish()`
   */
  public async publishOrThrow(event: ApplicationEvent): Promise<void> {
    const result = await this.publish(event);
    if (!result.ok) throw result.error;
  }

  /**
   * Публикует список событий; бросает вместо возврата `Err` (deprecation-мост, см. {@link IEventBus.publishAllOrThrow}).
   *
   * @param events - Список событий для последовательной публикации
   * @throws {QueueOverflowError | CriticalHandlerError} См. `publishAll()`
   */
  public async publishAllOrThrow(events: readonly ApplicationEvent[]): Promise<void> {
    const result = await this.publishAll(events);
    if (!result.ok) throw result.error;
  }

  /**
   * Запускает `_drainQueue()` и конвертирует её throw-based исход в `Result`.
   *
   * @returns `Ok(void)` при успешном опустошении очереди; `Err(QueueOverflowError)` если
   *   `_drainQueue()` бросила именно её (drain-limit); `Err(CriticalHandlerError)` для
   *   любого другого брошенного значения (raw throw critical-подписчика)
   */
  private async _drainAndConvert(): Promise<Result<void, QueueOverflowError | CriticalHandlerError>> {
    try {
      await this._drainQueue();
      return Ok(undefined);
    } catch (err) {
      if (err instanceof QueueOverflowError) return Err(err);
      return Err(new CriticalHandlerError(
        'EventBus critical handler threw during dispatch',
        { context: { originalError: err } },
      ));
    }
  }

  /**
   * Последовательно обрабатывает события из очереди до опустошения или лимита.
   *
   * @throws {QueueOverflowError} При превышении maxEventsPerDrain (перехватывается и
   *   конвертируется в `Err` на границе `publish()`/`publishAll()` — см.
   *   `_drainAndConvert()`, этот метод остаётся throw-based как внутренняя деталь).
   * @throws При critical ошибке handler'а — пробрасывается сырое значение из `_dispatch()`
   *   (тоже перехватывается и конвертируется в `Err(CriticalHandlerError)` на границе).
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
          drainError = new QueueOverflowError(
            `EventBus drain limit exceeded (${this._maxEventsPerDrain}): possible infinite event loop. ` +
              `Remaining events dropped.`,
            { context: { maxEventsPerDrain: this._maxEventsPerDrain } },
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
