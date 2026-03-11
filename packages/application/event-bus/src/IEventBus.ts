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

/**
 * Типизированный handler конкретного события.
 *
 * @typeParam T - Конкретный тип ApplicationEvent
 */
export type EventHandler<T extends ApplicationEvent> = (event: T) => Promise<void>;

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
   * @remarks
   * Handlers одного события НЕ должны зависеть от side-effects друг друга.
   * Публикация параллельная (Promise.all fanout).
   */
  publish(event: ApplicationEvent): Promise<void>;

  /**
   * Публикует список событий последовательно.
   *
   * @param events - Список событий для последовательной публикации
   * @remarks
   * Domain events из Order.pullEvents() имеют FSM-порядок.
   * Если публиковать параллельно — handlers могут увидеть события в неверном порядке.
   */
  publishAll(events: readonly ApplicationEvent[]): Promise<void>;

  /**
   * Подписывается на события конкретного типа.
   *
   * @param type - Тип события (ApplicationEvent['type'])
   * @param handler - Async handler для событий этого типа
   * @returns Функция отписки — вызвать при cleanup
   *
   * @example
   * ```typescript
   * const unsub = bus.subscribe('BOOK_UPDATED', async (event) => {
   *   // event здесь BookUpdatedEvent — TypeScript знает точный тип
   *   strategy.onBookUpdated(event.topOfBook);
   * });
   * ```
   */
  subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>,
    options?: { critical?: boolean },
  ): () => void;
}
