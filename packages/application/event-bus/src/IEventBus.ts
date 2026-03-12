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
   * @throws Если critical handler выбросил исключение, или очередь переполнена.
   * @remarks
   * Handlers одного события запускаются параллельно через Promise.allSettled —
   * все handlers дожидаются завершения перед переходом к следующему событию.
   * Handlers НЕ должны зависеть от side-effects друг друга.
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
   * @param options - Опции подписки
   * @param options.critical - Если true: ошибка handler пробрасывается из publish(),
   *   drain прерывается, bus остаётся работоспособным. По умолчанию false:
   *   ошибки логируются и не останавливают остальных handlers.
   * @returns Функция отписки — вызвать при cleanup
   *
   * @example
   * ```typescript
   * // Non-critical (по умолчанию): ошибки логируются
   * const unsub = bus.subscribe('BOOK_UPDATED', async (event) => {
   *   strategy.onBookUpdated(event.topOfBook);
   * });
   *
   * // Critical: ошибка пробрасывается caller'у
   * bus.subscribe('RISK_LIMIT_BREACHED', riskHandler, { critical: true });
   * ```
   */
  subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>,
    options?: { critical?: boolean },
  ): () => void;
}
