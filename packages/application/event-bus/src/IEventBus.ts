/**
 * Порт event bus — публикация и подписка на canonical `ApplicationEvent`.
 *
 * @remarks
 * По шине ходит ровно один контур — `ApplicationEvent` из
 * `@polymarket/application-events`. Сырые сообщения источников сюда не
 * попадают: они идут по `ExternalMessageBus` и превращаются в
 * `ApplicationEvent` semantic-адаптерами.
 *
 * EventHandler — async, потому что handlers делают await на use-cases / репозиториях.
 * subscribe() возвращает unsubscribe-функцию для cleanup (RAII-паттерн).
 *
 * @example
 * ```typescript
 * const unsub = eventBus.subscribe('BOOK_UPDATED', async (event) => {
 *   await strategy.onBookUpdated(event.payload.topOfBook);
 * });
 * // при cleanup:
 * unsub();
 * ```
 */
import type { ApplicationEvent } from '@polymarket/application-events';
import type { Result } from '@polymarket/result';
import type { QueueOverflowError, CriticalHandlerError } from '@polymarket/errors/event-bus';

/**
 * Типизированный handler конкретного события.
 *
 * @typeParam T - Конкретный член union `ApplicationEvent`
 *
 * @remarks
 * Разрешает как sync (`void`), так и async (`Promise<void>`) handlers.
 * Sync handlers не создают лишних Promise-объектов — EventBus обрабатывает оба варианта.
 * Async handlers используют `await` внутри (например, обращения к репозиторию).
 */
export type EventHandler<T extends ApplicationEvent> = (event: T) => void | Promise<void>;

/**
 * Интерфейс application event bus.
 *
 * @remarks
 * Реализация: EventBus (в этом пакете).
 * Используется: handlers, orchestrators, strategy (для подписки и публикации).
 */
export interface IEventBus {
  /**
   * Публикует одно событие всем подписчикам (fanout).
   *
   * @param event - Canonical `ApplicationEvent` для публикации
   * @returns `Ok(void)`, либо `Err(QueueOverflowError)` при переполнении очереди/лимита
   *   drain-цикла, либо `Err(CriticalHandlerError)` если critical-подписчик бросил
   * @remarks
   * Handlers одного события запускаются параллельно через Promise.allSettled —
   * все handlers дожидаются завершения перед переходом к следующему событию.
   * Handlers НЕ должны зависеть от side-effects друг друга.
   */
  publish(event: ApplicationEvent): Promise<Result<void, QueueOverflowError | CriticalHandlerError>>;

  /**
   * Публикует событие и подтверждает исход обработки ИМЕННО этого события.
   *
   * @param event - Canonical `ApplicationEvent` для публикации
   * @returns `Ok(void)` — все handlers ЭТОГО события завершились без critical-
   *   отказа; `Err(CriticalHandlerError)` — critical-отказ этого события
   *   (`context.messageId === event.metadata.messageId`) ЛИБО отказ уже
   *   существовавшего backlog, из-за которого событие не публиковалось вовсе
   *   (`context.messageId` — чужой); `Err(QueueOverflowError)` — событие не
   *   принято очередью либо backlog упёрся в лимит drain-цикла
   *
   * @remarks
   * ### Чем отличается от {@link IEventBus.publish}
   *
   * `publish()` при уже активном drain только ставит событие в очередь, и его
   * `Ok` подтверждает постановку, а не обработку. Это правильно для reentrant-
   * доставки, но не для внешней request/response-границы, которой нужен исход
   * конкретного события. `publishConfirmed()` устроен так:
   *
   * ```text
   * активен drain / в очереди backlog
   *     → дождаться его завершения (MessageBus.drain())
   *     → backlog упал            → Err, событие НЕ ставится в очередь вовсе
   * очередь пуста и drain нет
   *     → поставить событие       → оно ПЕРВОЕ в новом drain
   *     → дождаться drain
   *     → critical на этом событии           → Err
   *     → отказ ПОЗЖЕ, на другом событии     → Ok (это событие уже прошло fan-out)
   * ```
   *
   * Отказ, случившийся после события в том же drain, логируется, но исходом
   * этого события не считается.
   *
   * ### НЕ вызывать из handler'а
   *
   * Метод ждёт завершения активного drain. Handler, вызвавший его с `await`,
   * ждал бы сам себя — drain не завершится никогда. Внутри handler'ов —
   * только `publish()`.
   *
   * @example
   * ```typescript
   * const confirmed = await eventBus.publishConfirmed(reconciledEvent);
   * if (!confirmed.ok && confirmed.error.context?.messageId === reconciledEvent.metadata.messageId) {
   *   // отвергнуто именно это событие
   * }
   * ```
   */
  publishConfirmed(
    event: ApplicationEvent,
  ): Promise<Result<void, QueueOverflowError | CriticalHandlerError>>;

  /**
   * Публикует список событий последовательно.
   *
   * @param events - Список событий для последовательной публикации
   * @returns См. {@link IEventBus.publish}
   * @remarks
   * Порядок событий в batch значим (например, последовательные изменения одного
   * аккаунта). Если публиковать параллельно — handlers могут увидеть события в
   * неверном порядке.
   */
  publishAll(events: readonly ApplicationEvent[]): Promise<Result<void, QueueOverflowError | CriticalHandlerError>>;

  /**
   * Подписывается на события конкретного типа.
   *
   * @param type - Тип события (`ApplicationEvent['type']`)
   * @param handler - Async handler для событий этого типа
   * @param options - Опции подписки
   * @param options.critical - Если true: ошибка handler возвращается как
   *   `Err(CriticalHandlerError)` из `publish()`/`publishAll()`, drain прерывается, bus
   *   остаётся работоспособным. По умолчанию false: ошибки логируются и не останавливают
   *   остальных handlers.
   * @returns Функция отписки — вызвать при cleanup
   *
   * @example
   * ```typescript
   * // Non-critical (по умолчанию): ошибки логируются
   * const unsub = bus.subscribe('BOOK_UPDATED', async (event) => {
   *   strategy.onBookUpdated(event.payload.topOfBook);
   * });
   *
   * // Critical: ошибка возвращается caller'у как Err(CriticalHandlerError)
   * bus.subscribe('TRADING_ACCOUNT_ORDER_COMMITTED', projectorHandler, { critical: true });
   * ```
   */
  subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>,
    options?: { critical?: boolean },
  ): () => void;
}
