/**
 * Порт event bus — публикация и подписка на ApplicationEvent.
 *
 * @remarks
 * EventHandler — async, потому что handlers делают await на use-cases / репозиториях.
 * subscribe() возвращает unsubscribe-функцию для cleanup (RAII-паттерн).
 *
 * @example
 * ```typescript
 * const unsub = eventBus.subscribe('FILL_RECEIVED', async (event) => {
 *   await fillOrchestrator.handle(event.fill);
 * });
 * // при cleanup:
 * unsub();
 * ```
 */
import type { ApplicationEvent } from './events/index.js';
import type { Result } from '@polymarket/result';
import type { QueueOverflowError, CriticalHandlerError } from '@polymarket/errors/event-bus';

/**
 * Типизированный handler конкретного события.
 *
 * @typeParam T - Конкретный тип ApplicationEvent
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
   * @param event - ApplicationEvent для публикации
   * @returns `Ok(void)`, либо `Err(QueueOverflowError)` при переполнении очереди/лимита
   *   drain-цикла, либо `Err(CriticalHandlerError)` если critical-подписчик бросил
   * @remarks
   * Handlers одного события запускаются параллельно через Promise.allSettled —
   * все handlers дожидаются завершения перед переходом к следующему событию.
   * Handlers НЕ должны зависеть от side-effects друг друга.
   */
  publish(event: ApplicationEvent): Promise<Result<void, QueueOverflowError | CriticalHandlerError>>;

  /**
   * Публикует список событий последовательно.
   *
   * @param events - Список событий для последовательной публикации
   * @returns См. {@link IEventBus.publish}
   * @remarks
   * Domain events из Order.pullEvents() имеют FSM-порядок.
   * Если публиковать параллельно — handlers могут увидеть события в неверном порядке.
   */
  publishAll(events: readonly ApplicationEvent[]): Promise<Result<void, QueueOverflowError | CriticalHandlerError>>;

  /**
   * Публикует одно событие; бросает вместо возврата `Err` (deprecation-мост).
   *
   * @param event - ApplicationEvent для публикации
   * @throws {QueueOverflowError} При переполнении очереди/лимита drain-цикла
   * @throws {CriticalHandlerError} Если critical-подписчик бросил
   *
   * @remarks
   * Временный мост для вызывающего кода вне `application/handlers`, ещё не переведённого
   * на `Result` (Этап 6 плана миграции). Бросает **тот же объект ошибки**, что
   * `publish()` вернул бы в `Err` — поведение для уже существующих вызывающих не меняется.
   * Снимается в Этапе 10 плана миграции, когда все вызывающие переходят на `publish()`.
   */
  publishOrThrow(event: ApplicationEvent): Promise<void>;

  /**
   * Публикует список событий; бросает вместо возврата `Err` (deprecation-мост).
   *
   * @param events - Список событий для последовательной публикации
   * @throws {QueueOverflowError} При переполнении очереди/лимита drain-цикла
   * @throws {CriticalHandlerError} Если critical-подписчик бросил
   *
   * @remarks
   * См. {@link IEventBus.publishOrThrow} — тот же мост для `publishAll()`.
   */
  publishAllOrThrow(events: readonly ApplicationEvent[]): Promise<void>;

  /**
   * Подписывается на события конкретного типа.
   *
   * @param type - Тип события (ApplicationEvent['type'])
   * @param handler - Async handler для событий этого типа
   * @param options - Опции подписки
   * @param options.critical - Если true: ошибка handler возвращается как
   *   `Err(CriticalHandlerError)` из `publish()`/`publishAll()` (бросается из
   *   `publishOrThrow()`/`publishAllOrThrow()`), drain прерывается, bus остаётся
   *   работоспособным. По умолчанию false: ошибки логируются и не останавливают
   *   остальных handlers.
   * @returns Функция отписки — вызвать при cleanup
   *
   * @example
   * ```typescript
   * // Non-critical (по умолчанию): ошибки логируются
   * const unsub = bus.subscribe('BOOK_UPDATED', async (event) => {
   *   strategy.onBookUpdated(event.topOfBook);
   * });
   *
   * // Critical: ошибка возвращается caller'у как Err(CriticalHandlerError)
   * bus.subscribe('RISK_LIMIT_BREACHED', riskHandler, { critical: true });
   * ```
   */
  subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>,
    options?: { critical?: boolean },
  ): () => void;
}
