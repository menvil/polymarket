/**
 * IEventBus - Интерфейс шины событий
 *
 * @remarks
 * Определяет **минимальный контракт** для event-driven архитектуры.
 * EventBus - это **максимально простой dispatcher** без бизнес-логики.
 *
 * ## Контракт EventBus (гарантии):
 *
 * ### 1. Async boundary (асинхронная граница)
 * - `publish()` **немедленно возвращает управление** (синхронный вызов)
 * - Handlers вызываются **асинхронно** в следующем event loop tick (через setImmediate)
 * - Producer **никогда не блокируется** на consumers
 * - Producer **никогда не получает** ошибки от consumers
 *
 * ### 2. Error isolation (изоляция ошибок)
 * - Ошибка в одном handler **НЕ влияет** на другие handlers
 * - Ошибки **НЕ пробрасываются** в producer
 * - Ошибки **передаются в EventBusErrorHandler** для логирования
 * - EventBus **продолжает работу** после любой ошибки
 *
 * ### 3. Best-effort delivery (доставка "на лучших условиях")
 * - EventBus **делает попытку вызвать** каждый handler один раз
 * - Если handler бросает ошибку - попытка считается выполненной
 * - **НЕТ автоматических retry** (повторов)
 * - **НЕТ гарантий доставки** при краше процесса
 *
 * ### 4. Idempotency requirement (требование идемпотентности)
 * - Subscribers **ДОЛЖНЫ быть idempotent**
 * - Handler может быть вызван повторно (при будущих retry/replay механизмах)
 * - Handler должен корректно обрабатывать дубликаты событий
 *
 * ### 5. Synchronous handlers (синхронные обработчики)
 * - Handlers **ДОЛЖНЫ быть синхронными**: `(event: T) => void`
 * - Если нужна async работа - делать внутри через `Promise.resolve().then(...)` (fire-and-forget)
 * - EventBus **НЕ ожидает** завершения async операций
 *
 * ### 6. No ordering guarantees (НЕТ гарантий порядка)
 * - **НЕТ гарантий** порядка вызова разных handlers
 * - **НЕТ гарантий** порядка обработки разных событий
 * - **НЕТ гарантий** порядка между specific и "all" handlers
 * - Текущая реализация может использовать FIFO, но это **НЕ контракт**
 *
 * ### 7. No reentrancy issues (защита от reentrancy)
 * - Subscriber может вызвать `publish()` внутри handler
 * - **НЕТ stack overflow** при вложенных `publish()`
 * - Реализация должна предотвращать бесконечную рекурсию
 *
 * @example
 * ```typescript
 * import { ConsoleLogger } from './infrastructure/logging/ConsoleLogger';
 *
 * const logger = new ConsoleLogger();
 * const bus: IEventBus = new InMemoryEventBus(logger);
 *
 * // Подписка на событие
 * const unsubscribe = bus.subscribe('OrderBookSnapshotReceived', (event) => {
 *   console.log('Orderbook update:', event.assetId);
 * });
 *
 * // Публикация события (возвращается сразу!)
 * bus.publish(new OrderBookSnapshotReceivedEvent(...));
 * console.log('publish() returned immediately');
 * // → handler вызовется ПОЗЖЕ (async, в следующем tick)
 *
 * // Отписка
 * unsubscribe();
 * ```
 */

import type { DomainEvent } from '../../domain/events/DomainEvent.js';

/**
 * Event handler function
 *
 * @remarks
 * Синхронная функция для обработки domain событий.
 * Если handler бросает ошибку, она изолируется и не влияет на другие handlers.
 *
 * ВАЖНО: Handler должен быть **idempotent** (переживёт повторную доставку).
 *
 * @template T - Тип domain события (по умолчанию DomainEvent)
 */
export type EventHandler<T extends DomainEvent = DomainEvent> = (event: T) => void;

/**
 * IEventBus - Интерфейс шины событий
 *
 * @remarks
 * Определяет контракт для асинхронной event-driven архитектуры.
 */
export interface IEventBus {
  /**
   * Публикует событие всем подписчикам
   *
   * @param event - Domain событие для публикации
   *
   * @remarks
   * **КРИТИЧНО**: Метод **немедленно возвращает управление** (синхронный).
   * Handlers вызываются **асинхронно** в следующем event loop tick (через setImmediate).
   *
   * Контрактные гарантии:
   * - **Async boundary**: publish() возвращается мгновенно, не блокируется
   * - **Error isolation**: ошибки handlers не влияют на producer
   * - **Best-effort**: попытка вызвать каждый handler один раз
   * - **No ordering**: НЕТ гарантий порядка вызова handlers
   * - **Reentrancy safe**: безопасно вызывать publish() из handler
   *
   * @example
   * ```typescript
   * const event = new OrderBookSnapshotReceivedEvent(...);
   * bus.publish(event);
   * console.log('returned immediately');
   * // → handlers вызовутся ПОЗЖЕ (асинхронно, порядок не гарантирован)
   * ```
   */
  publish(event: DomainEvent): void;

  /**
   * Подписывается на конкретный тип события
   *
   * @param eventName - Имя события для подписки (например, 'OrderBookSnapshotReceived')
   * @param handler - Handler для вызова при публикации события
   * @returns Функция отписки
   *
   * @remarks
   * Handler добавляется в конец массива (сохраняет порядок подписки).
   * Множественные подписки с одним handler разрешены (каждая получает отдельный unsubscribe).
   *
   * @example
   * ```typescript
   * const unsubscribe = bus.subscribe('TradeExecuted', (event) => {
   *   console.log('Trade:', event.price, event.size);
   * });
   *
   * // Позже: отписка
   * unsubscribe();
   * ```
   */
  subscribe(eventName: string, handler: EventHandler): () => void;

  /**
   * Подписывается на все события
   *
   * @param handler - Handler для вызова при любом опубликованном событии
   * @returns Функция отписки
   *
   * @remarks
   * Handler вызывается для КАЖДОГО события, независимо от eventName.
   * Полезно для логирования, мониторинга или сбора данных.
   *
   * @example
   * ```typescript
   * const unsubscribe = bus.subscribeAll((event) => {
   *   console.log('Any event:', event.eventName, event.timestamp);
   * });
   *
   * // Позже: отписка
   * unsubscribe();
   * ```
   */
  subscribeAll(handler: EventHandler): () => void;

  /**
   * Получает количество подписчиков для конкретного события
   *
   * @param eventName - Имя события для проверки
   * @returns Количество handlers подписанных на это событие
   *
   * @remarks
   * Утилитный метод для тестирования и отладки.
   */
  getSubscriberCount(eventName: string): number;

  /**
   * Получает количество подписчиков на все события
   *
   * @returns Количество handlers подписанных на все события
   *
   * @remarks
   * Утилитный метод для тестирования и отладки.
   */
  getAllSubscriberCount(): number;

  /**
   * Очищает все подписки
   *
   * @remarks
   * Удаляет все handlers (как specific, так и "all events").
   * Утилитный метод для cleanup в тестах.
   */
  clear(): void;
}
