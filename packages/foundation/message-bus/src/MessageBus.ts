/**
 * MessageBus — generic in-process движок доставки типизированных сообщений.
 *
 * @remarks
 * ### Архитектурные свойства
 *
 * #### 1. Queue-based dispatch, один активный drain
 * `publish()`/`publishAll()` ставят сообщения в FIFO-очередь. Если drain не идёт —
 * вызывающий становится его владельцем и получает итоговый drain-Result. Если drain
 * уже активен (reentrant-вызов из обработчика или конкурентная публикация) —
 * сообщение просто enqueue-ится, `Ok` подтверждает постановку в очередь, а не
 * завершение обработки. Второй drain никогда не запускается.
 *
 * #### 2. FIFO между сообщениями, параллельный fan-out внутри сообщения
 * Обработчики одного сообщения запускаются параллельно; следующий message
 * диспетчеризуется только после завершения (settle) всех обработчиков текущего.
 * Reentrant-публикации попадают в хвост очереди: `publishAll([A,B])` +
 * `handler(A) → publish(C)` даёт порядок `A → B → C`.
 *
 * #### 3. Ошибки конструируются в точке возникновения
 * Overflow — на capacity-check, critical-ошибка обработчика — сразу после fan-out
 * (где известны `message.type` и исходное значение), drain-limit — внутри drain.
 * Никакой поздней классификации по `instanceof`: ошибка, брошенная обработчиком
 * (даже экземпляр ошибки самого bus), всегда остаётся `originalError` внутри
 * `MessageBusCriticalHandlerError`.
 *
 * #### 4. Result-граница
 * Ожидаемые operational-исходы возвращаются как `Result` из
 * `publish`/`publishAll`/`drain`/`close`. Синхронный throw возможен только при
 * невалидной политике в конструкторе (configuration error). Неожиданное внутреннее
 * исключение (нарушение инварианта — баг) пропагирует как rejected promise, а не
 * маскируется под operational-Result.
 *
 * #### 5. Без зависимостей на прикладные слои
 * Пакет знает только `message.type`. Диагностика — через опциональный
 * {@link MessageBusObserver} (не logger) и дешёвые счётчики {@link MessageBusStats}.
 */
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { TypedMessage } from './TypedMessage.js';
import type { MessageHandler } from './MessageHandler.js';
import type { IMessageBus } from './IMessageBus.js';
import type { MessageBusStats } from './MessageBusStats.js';
import type { MessageBusObserver } from './MessageBusObserver.js';
import type { MessageBusPolicy } from './MessageBusPolicy.js';
import { DEFAULT_MESSAGE_BUS_POLICY, validateMessageBusPolicy } from './MessageBusPolicy.js';
import {
  MessageBusOverflowError,
  MessageBusCriticalHandlerError,
  MessageBusDrainLimitError,
  MessageBusClosedError,
} from './errors.js';
import type { MessageBusDrainError, MessageBusPublishError } from './errors.js';
import { FifoMessageQueue } from './queue/FifoMessageQueue.js';

/**
 * Запись о подписчике: обработчик + флаг критичности.
 */
type HandlerEntry<TMessage> = {
  readonly handler: MessageHandler<TMessage>;
  readonly critical: boolean;
};

/**
 * Опции конструктора MessageBus.
 */
export interface MessageBusOptions {
  /** Политика доставки; по умолчанию {@link DEFAULT_MESSAGE_BUS_POLICY}. */
  readonly policy?: MessageBusPolicy;
  /** Опциональный observer диагностических событий (best-effort, изолирован). */
  readonly observer?: MessageBusObserver;
}

/**
 * Реализация {@link IMessageBus}.
 *
 * @typeParam TMessage - Discriminated union сообщений контура (требуется только `type`)
 *
 * @example
 * ```typescript
 * type Message =
 *   | { readonly type: 'PRICE'; readonly price: number }
 *   | { readonly type: 'TRADE'; readonly tradeId: string };
 *
 * const bus = new MessageBus<Message>();
 *
 * const unsubscribe = bus.subscribe('PRICE', (message) => {
 *   // message сужен до { type: 'PRICE'; price: number }
 *   process(message.price);
 * });
 *
 * const result = await bus.publish({ type: 'PRICE', price: 0.42 });
 * if (!result.ok) {
 *   report(result.error);
 * }
 * ```
 */
export class MessageBus<TMessage extends TypedMessage> implements IMessageBus<TMessage> {
  private readonly _policy: MessageBusPolicy;
  private readonly _observer: MessageBusObserver | undefined;
  private readonly _queue = new FifoMessageQueue<TMessage>();
  private readonly _handlers = new Map<string, Set<HandlerEntry<TMessage>>>();
  private _dispatching = false;
  private _closed = false;
  private _activeDrain: Promise<Result<void, MessageBusDrainError>> | undefined;
  private _publishedTotal = 0;
  private _dispatchedTotal = 0;
  private _handlerErrorsTotal = 0;
  private _rejectedPublicationsTotal = 0;

  /**
   * Создаёт MessageBus.
   *
   * @param options - Политика и опциональный observer
   * @throws {RangeError} Если политика невалидна (лимиты не положительные safe
   *   integers) — configuration error, в отличие от runtime-исходов доставки,
   *   которые всегда возвращаются как `Result`
   */
  constructor(options: MessageBusOptions = {}) {
    const policy = options.policy ?? DEFAULT_MESSAGE_BUS_POLICY;
    validateMessageBusPolicy(policy);
    this._policy = policy;
    this._observer = options.observer;
  }

  /** @inheritDoc */
  public async publish(message: TMessage): Promise<Result<void, MessageBusPublishError>> {
    if (this._closed) {
      this._rejectedPublicationsTotal++;
      return Err(new MessageBusClosedError());
    }
    if (this._queue.size + 1 > this._policy.queuePolicy.maxQueueSize) {
      return Err(this._rejectOverflow(1, message.type));
    }
    this._queue.enqueue(message);
    this._publishedTotal++;
    if (this._dispatching) {
      // Drain уже активен: Ok подтверждает enqueue, сообщение доставит текущий drain
      return Ok(undefined);
    }
    return this._startDrain();
  }

  /** @inheritDoc */
  public async publishAll(messages: readonly TMessage[]): Promise<Result<void, MessageBusPublishError>> {
    if (this._closed) {
      this._rejectedPublicationsTotal++;
      return Err(new MessageBusClosedError());
    }
    if (messages.length === 0) {
      return Ok(undefined);
    }
    if (this._queue.size + messages.length > this._policy.queuePolicy.maxQueueSize) {
      // All or nothing: не влезающий batch отклоняется целиком, очередь не затронута
      return Err(this._rejectOverflow(messages.length, undefined));
    }
    this._queue.enqueueMany(messages);
    this._publishedTotal += messages.length;
    if (this._dispatching) {
      return Ok(undefined);
    }
    return this._startDrain();
  }

  /** @inheritDoc */
  public subscribe<K extends TMessage['type']>(
    type: K,
    handler: MessageHandler<Extract<TMessage, { type: K }>>,
    options?: { critical?: boolean },
  ): () => void {
    let entries = this._handlers.get(type);
    if (!entries) {
      entries = new Set();
      this._handlers.set(type, entries);
    }
    const entry: HandlerEntry<TMessage> = {
      handler: handler as MessageHandler<TMessage>,
      critical: options?.critical ?? false,
    };
    entries.add(entry);
    return () => {
      const current = this._handlers.get(type);
      if (!current) return;
      current.delete(entry);
      if (current.size === 0) {
        this._handlers.delete(type);
      }
    };
  }

  /** @inheritDoc */
  public async drain(): Promise<Result<void, MessageBusDrainError>> {
    if (this._activeDrain) {
      // Один активный drain: дожидаемся существующего, второй не запускаем
      return this._activeDrain;
    }
    if (this._queue.size === 0) {
      return Ok(undefined);
    }
    return this._startDrain();
  }

  /** @inheritDoc */
  public async close(): Promise<Result<void, MessageBusDrainError>> {
    this._closed = true;
    if (this._activeDrain) {
      return this._activeDrain;
    }
    if (this._queue.size === 0) {
      return Ok(undefined);
    }
    return this._startDrain();
  }

  /** @inheritDoc */
  public getStats(): MessageBusStats {
    return {
      queueSize: this._queue.size,
      subscribedTypes: this._handlers.size,
      dispatching: this._dispatching,
      closed: this._closed,
      publishedTotal: this._publishedTotal,
      dispatchedTotal: this._dispatchedTotal,
      handlerErrorsTotal: this._handlerErrorsTotal,
      rejectedPublicationsTotal: this._rejectedPublicationsTotal,
    };
  }

  /**
   * Конструирует overflow-ошибку в точке отклонения и уведомляет observer.
   *
   * @param attemptedCount - Размер отклонённой публикации
   * @param messageType - Тип сообщения (для одиночного publish)
   * @returns Готовая ошибка для `Err`
   */
  private _rejectOverflow(attemptedCount: number, messageType: string | undefined): MessageBusOverflowError {
    this._rejectedPublicationsTotal++;
    const context = {
      maxQueueSize: this._policy.queuePolicy.maxQueueSize,
      attemptedCount,
      queueSize: this._queue.size,
      messageType,
    };
    this._notifyObserver(() => this._observer?.onQueueOverflow?.(context));
    return new MessageBusOverflowError({
      maxQueueSize: this._policy.queuePolicy.maxQueueSize,
      attemptedCount,
      messageType,
    });
  }

  /**
   * Запускает drain и регистрирует его как единственный активный.
   *
   * @returns Promise итогового drain-Result (его же увидят `drain()`/`close()`)
   *
   * @remarks
   * `_runDrain()` выставляет `_dispatching = true` синхронно первой строкой —
   * до присваивания `_activeDrain`. Поэтому reentrant-публикации из синхронного
   * префикса обработчиков проверяют именно `_dispatching` и не запускают второй
   * drain; внешние вызовы `drain()`/`close()` физически не могут наблюдать окно
   * между стартом `_runDrain()` и присваиванием (управление не возвращается в
   * event loop до завершения обоих).
   */
  private _startDrain(): Promise<Result<void, MessageBusDrainError>> {
    const drainPromise = this._runDrain().finally(() => {
      this._activeDrain = undefined;
    });
    this._activeDrain = drainPromise;
    return drainPromise;
  }

  /**
   * Основной drain-цикл: FIFO-обработка очереди до опустошения или терминального исхода.
   *
   * @returns `Ok` при опустошении очереди; `Err(MessageBusDrainLimitError)` при
   *   срабатывании защиты от петли (очередь очищается); `Err(MessageBusCriticalHandlerError)`
   *   при падении critical-обработчика (очередь сохраняется, упавшее сообщение
   *   считается обработанным и не replay-ится)
   */
  private async _runDrain(): Promise<Result<void, MessageBusDrainError>> {
    this._dispatching = true;
    let processed = 0;
    try {
      while (this._queue.size > 0) {
        if (processed >= this._policy.queuePolicy.maxMessagesPerDrain) {
          // Оставшаяся очередь — артефакт бесконечной петли публикаций, не backlog
          const clearedCount = this._queue.size;
          this._queue.clear();
          const context = {
            maxMessagesPerDrain: this._policy.queuePolicy.maxMessagesPerDrain,
            clearedCount,
          };
          this._notifyObserver(() => this._observer?.onDrainLimitExceeded?.(context));
          return Err(new MessageBusDrainLimitError({
            maxMessagesPerDrain: this._policy.queuePolicy.maxMessagesPerDrain,
          }));
        }
        const message = this._queue.dequeue() as TMessage;
        const criticalError = await this._dispatchMessage(message);
        processed++;
        this._dispatchedTotal++;
        if (criticalError !== undefined) {
          // Critical-исход: drain останавливается, оставшаяся очередь сохраняется
          return Err(criticalError);
        }
      }
      return Ok(undefined);
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * Параллельный fan-out одного сообщения по snapshot подписчиков.
   *
   * @param message - Сообщение для доставки
   * @returns Каноническая (первая в порядке snapshot) critical-ошибка, либо
   *   `undefined` если critical-исхода нет
   *
   * @remarks
   * Snapshot подписчиков фиксируется до запуска обработчиков: отписка во время
   * fan-out не исключает обработчик из текущего сообщения, подписка — не добавляет.
   *
   * async-обёртка вокруг вызова обработчика нормализует синхронный throw в
   * rejection: sync-ошибка попадает в fan-out наравне с async-ошибкой, не
   * прерывая запуск siblings.
   *
   * Все падения (critical и non-critical) увеличивают `handlerErrorsTotal` и
   * сообщаются observer'у; дополнительные critical-ошибки после первой не
   * теряются — они уходят observer'у с `primaryCritical: false`.
   */
  private async _dispatchMessage(message: TMessage): Promise<MessageBusCriticalHandlerError | undefined> {
    const entries = this._handlers.get(message.type);
    if (!entries || entries.size === 0) {
      return undefined;
    }
    const snapshot = [...entries];
    const settled = await Promise.allSettled(
      snapshot.map(async (entry) => { await entry.handler(message); }),
    );

    let primaryError: MessageBusCriticalHandlerError | undefined;
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status !== 'rejected') continue;
      const entry = snapshot[i];
      this._handlerErrorsTotal++;
      const isPrimaryCritical = entry.critical && primaryError === undefined;
      if (isPrimaryCritical) {
        primaryError = new MessageBusCriticalHandlerError({
          messageType: message.type,
          originalError: outcome.reason,
        });
      }
      const context = {
        messageType: message.type,
        originalError: outcome.reason,
        critical: entry.critical,
        primaryCritical: isPrimaryCritical,
      };
      this._notifyObserver(() => this._observer?.onHandlerError?.(context));
    }
    return primaryError;
  }

  /**
   * Best-effort уведомление observer'а.
   *
   * @param notify - Замыкание вызова конкретного callback
   *
   * @remarks
   * Исключение observer'а перехватывается и игнорируется: telemetry-hook не имеет
   * права влиять на доставку, Result операций или состояние очереди.
   */
  private _notifyObserver(notify: () => void): void {
    try {
      notify();
    } catch {
      // Observer изолирован: его падение не должно ломать движок доставки
    }
  }
}
