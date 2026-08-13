/**
 * EventBus — Application-фасад над generic `MessageBus<ApplicationEvent>`.
 *
 * @remarks
 * ### Архитектура после M-002
 *
 * ```text
 * EventBus (этот класс)
 * ├── Application-specific публичный контракт (IEventBus)
 * ├── трансляция ошибок: MessageBus*Error → QueueOverflowError/CriticalHandlerError
 * ├── logger-адаптер через MessageBusObserver
 * └── legacy-проекция диагностики (getStats)
 *       │
 *       ▼
 * MessageBus<ApplicationEvent>   ← вся механика доставки
 * ```
 *
 * Собственного механизма доставки у EventBus больше НЕТ: очередь, FIFO,
 * параллельный fan-out, reentrancy, critical/non-critical семантика, overflow и
 * drain-limit защиты — целиком ответственность `@polymarket/message-bus`
 * (композиция, не наследование: generic lifecycle `drain()`/`close()` и
 * расширенные stats движка сознательно НЕ становятся публичным API Application
 * EventBus).
 *
 * ### Публичный контракт не изменён
 * Поведенческий контракт зафиксирован M-000 (см. README пакета) и покрыт
 * contract-suite — он остаётся единственным источником истины. Наружу уходят
 * только Application-ошибки:
 *
 * | Ошибка движка                    | Публичный Result                         |
 * |----------------------------------|------------------------------------------|
 * | `MessageBusOverflowError`        | `Err(QueueOverflowError)`                |
 * | `MessageBusDrainLimitError`      | `Err(QueueOverflowError)` — M-000: один  |
 * |                                  | публичный класс для обеих причин         |
 * | `MessageBusCriticalHandlerError` | `Err(CriticalHandlerError)` c eventType  |
 * |                                  | и originalError в context                |
 * | `MessageBusClosedError`          | invariant violation (недостижимо: у      |
 * |                                  | IEventBus нет close(), фасад не          |
 * |                                  | закрывает внутренний bus)                |
 *
 * Тексты сообщений и context-поля публичных ошибок воспроизводят формат M-000
 * дословно — Foundation-терминология наружу не протекает.
 */
import type { ILogger } from '@polymarket/logger';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { QueueOverflowError, CriticalHandlerError } from '@polymarket/errors/event-bus';
import {
  MessageBus,
  createMessageBusPolicy,
  MessageBusOverflowError,
  MessageBusCriticalHandlerError,
  MessageBusDrainLimitError,
  MessageBusClosedError,
} from '@polymarket/message-bus';
import type { MessageBusObserver, MessageBusPublishError } from '@polymarket/message-bus';
import type { ApplicationEvent } from './events/index.js';
import type { IEventBus, EventHandler } from './IEventBus.js';

/**
 * Application event bus — тонкий фасад над `MessageBus<ApplicationEvent>`.
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
  private readonly _logger: ILogger;
  private readonly _bus: MessageBus<ApplicationEvent>;

  /**
   * Создаёт EventBus.
   *
   * @param logger - Logger для диагностики (child с component: 'EventBus')
   * @param maxEventsPerDrain - Лимит событий за один drain цикл (защита от infinite loops).
   *   По умолчанию 10 000. При превышении: Err(QueueOverflowError) + очистка очереди.
   * @param maxQueueSize - Максимальный размер очереди ожидающих событий (защита от OOM).
   *   По умолчанию 100 000. publish()/publishAll() возвращают Err(QueueOverflowError)
   *   если лимит превышен.
   * @throws {RangeError} Если лимиты не являются положительными safe integers —
   *   configuration error (валидацию выполняет конструктор MessageBus)
   *
   * @remarks
   * Legacy-параметры адаптируются в policy движка:
   * `maxEventsPerDrain → queuePolicy.maxMessagesPerDrain`,
   * `maxQueueSize → queuePolicy.maxQueueSize`. Остальные группы policy —
   * default-значения M-001, в точности воспроизводящие семантику M-000
   * (reject-new overflow, parallel fan-out,
   * continue/stop-drain-preserve-queue/clear-queue).
   */
  constructor(logger: ILogger, maxEventsPerDrain = 10_000, maxQueueSize = 100_000) {
    this._logger = logger.child({ component: 'EventBus' });
    this._bus = new MessageBus<ApplicationEvent>({
      policy: createMessageBusPolicy({
        queuePolicy: {
          maxQueueSize,
          maxMessagesPerDrain: maxEventsPerDrain,
        },
      }),
      observer: this._createLoggerObserver(),
    });
  }

  /**
   * Возвращает диагностические метрики bus'а (legacy-проекция).
   *
   * @returns Снимок текущего состояния: размер очереди, количество типов событий с подписчиками, флаг активного drain.
   *
   * @remarks
   * Проекция generic-статистики движка на исторический Application-shape M-000.
   * Расширенные счётчики движка (publishedTotal, dispatchedTotal, closed, ...)
   * наружу сознательно НЕ отдаются — это отдельное решение вне M-002.
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
    const stats = this._bus.getStats();
    return {
      queueSize: stats.queueSize,
      subscribedTypes: stats.subscribedTypes,
      dispatching: stats.dispatching,
    };
  }

  /**
   * Подписывается на события конкретного типа.
   *
   * @param type - Тип события
   * @param handler - Sync/async handler. Должен завершаться самостоятельно — EventBus не
   *   управляет timeout. Зависший handler заблокирует весь drain цикл.
   * @param options - Опции подписки: { critical?: boolean }
   * @returns Функция отписки (идемпотентна)
   *
   * @remarks
   * Прямой passthrough в generic subscription mechanism движка: compile-time
   * narrowing, snapshot-семантика мутаций во время dispatch и идемпотентность
   * отписки — его гарантии. Второго subscription-хранилища в фасаде нет.
   *
   * critical=true: ошибка handler возвращается как Err(CriticalHandlerError), drain
   * прерывается. Используется для RISK-событий, нарушение которых требует немедленной
   * реакции caller'а.
   */
  public subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>,
    options?: { critical?: boolean },
  ): () => void {
    return this._bus.subscribe(type, handler, options);
  }

  /**
   * Публикует событие всем подписчикам его типа.
   *
   * @param event - ApplicationEvent для публикации
   * @returns `Ok(void)`, либо `Err(QueueOverflowError)` при переполнении очереди/лимита
   *   drain-цикла, либо `Err(CriticalHandlerError)` если critical-подписчик бросил
   *
   * @remarks
   * Reentrant-safe (гарантия движка): вызов изнутри handler ставит событие в
   * очередь и подтверждает enqueue, обработка — текущим drain позже.
   */
  public async publish(event: ApplicationEvent): Promise<Result<void, QueueOverflowError | CriticalHandlerError>> {
    return this._translateResult(await this._bus.publish(event));
  }

  /**
   * Публикует список событий с сохранением порядка.
   *
   * @param events - Список событий для последовательной публикации
   * @returns См. {@link EventBus.publish}
   *
   * @remarks
   * Атомарность batch enqueue (all or nothing при overflow) и порядок
   * `A → B → C` с reentrant-поведением — гарантии движка.
   */
  public async publishAll(events: readonly ApplicationEvent[]): Promise<Result<void, QueueOverflowError | CriticalHandlerError>> {
    return this._translateResult(await this._bus.publishAll(events));
  }

  /**
   * Транслирует Result движка в публичный Application-Result.
   *
   * @param result - Result generic-движка
   * @returns `Ok`, либо Application-ошибка в формате M-000
   * @throws {Error} При `MessageBusClosedError` или неизвестной ошибке движка —
   *   нарушение внутреннего инварианта (см. remarks)
   *
   * @remarks
   * Единственная точка error translation boundary — exhaustive по union
   * `MessageBusPublishError` (замыкается `never`-веткой: новая ошибка движка
   * не пройдёт через typecheck незамеченной).
   *
   * Классификация — только по `instanceof` typed-классов движка, никакого
   * string-matching. Движок сам гарантирует происхождение ошибок: ошибка,
   * брошенная handler-ом (даже экземпляр Application `QueueOverflowError`),
   * приходит сюда уже внутри `MessageBusCriticalHandlerError.originalError`
   * и не может быть перепутана с операционным overflow.
   *
   * `MessageBusClosedError` недостижим публичным API: `IEventBus` не имеет
   * `close()`, фасад никогда не вызывает `_bus.close()`. Его появление —
   * programmer invariant violation → throw (rejected promise), а не маскировка
   * под Application-ошибку с ложной семантикой.
   */
  private _translateResult(
    result: Result<void, MessageBusPublishError>,
  ): Result<void, QueueOverflowError | CriticalHandlerError> {
    if (result.ok) return Ok(undefined);
    const error = result.error;

    if (error instanceof MessageBusOverflowError) {
      // Одиночный publish несёт messageType; batch — только attemptedCount.
      // Воспроизводим legacy-формат M-000 message/context дословно.
      if (error.messageType !== undefined) {
        return Err(new QueueOverflowError(
          `EventBus queue overflow (${error.maxQueueSize}): cannot enqueue ${error.messageType}`,
          { context: { maxQueueSize: error.maxQueueSize, eventType: error.messageType } },
        ));
      }
      return Err(new QueueOverflowError(
        `EventBus queue overflow (${error.maxQueueSize}): cannot enqueue ${error.attemptedCount} events`,
        { context: { maxQueueSize: error.maxQueueSize, eventCount: error.attemptedCount } },
      ));
    }

    if (error instanceof MessageBusDrainLimitError) {
      // M-000 сознательно использует один публичный класс для overflow и drain-guard
      return Err(new QueueOverflowError(
        `EventBus drain limit exceeded (${error.maxMessagesPerDrain}): possible infinite event loop. ` +
          `Remaining events dropped.`,
        { context: { maxEventsPerDrain: error.maxMessagesPerDrain } },
      ));
    }

    if (error instanceof MessageBusCriticalHandlerError) {
      return Err(new CriticalHandlerError(
        `EventBus critical handler threw during dispatch of ${error.messageType}`,
        { context: { originalError: error.originalError, eventType: error.messageType } },
      ));
    }

    if (error instanceof MessageBusClosedError) {
      // Недостижимо: у публичного контракта нет close(), фасад bus не закрывает
      throw new Error(
        'EventBus invariant violation: internal message bus reported closed state',
      );
    }

    return EventBus._unreachableEngineError(error);
  }

  /**
   * Exhaustiveness-guard трансляции: компиляция падает, если union ошибок движка
   * расширится и новая ошибка не получит явной ветки перевода.
   *
   * @param error - Значение, которое обязано иметь тип `never`
   * @throws {Error} Всегда — достижимо только при нарушении инварианта в runtime
   */
  private static _unreachableEngineError(error: never): never {
    throw new Error(
      `EventBus invariant violation: unknown message bus error: ${String(error)}`,
    );
  }

  /**
   * Создаёт observer, воспроизводящий legacy-логирование M-000 через ILogger.
   *
   * @returns Observer для конструктора движка
   *
   * @remarks
   * Ровно исторические log-вызовы, ничего нового:
   * - non-critical падение → `EventBus handler threw an error` (err, eventType);
   * - дополнительные critical-ошибки после первой →
   *   `EventBus critical handler threw an additional error` (err, eventType);
   * - primary critical НЕ логируется — возвращается caller'у как
   *   `Err(CriticalHandlerError)` (M-000: без duplicate-логов);
   * - overflow/drain-limit старый EventBus сам не логировал — не логируем и
   *   здесь (callbacks не реализованы).
   */
  private _createLoggerObserver(): MessageBusObserver {
    return {
      onHandlerError: (context) => {
        if (!context.critical) {
          this._logger.error('EventBus handler threw an error', {
            err: context.originalError,
            eventType: context.messageType,
          });
          return;
        }
        if (!context.primaryCritical) {
          this._logger.error('EventBus critical handler threw an additional error', {
            err: context.originalError,
            eventType: context.messageType,
          });
        }
      },
    };
  }
}
