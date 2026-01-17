/**
 * InMemoryEventStore - хранилище событий в памяти
 *
 * @remarks
 * Простая реализация EventStore для хранения истории всех domain events.
 *
 * Features:
 * - Сохранение всех событий в памяти (array)
 * - Поиск событий по типу/aggregateId/временному диапазону
 * - Replay событий (для debugging и testing)
 * - Очистка store (для тестов)
 *
 * Используется для:
 * - Debugging (просмотр истории событий)
 * - Testing (replay scenarios)
 * - Audit trail (кто/что/когда)
 * - Event sourcing (восстановление state из событий)
 *
 * @example
 * ```typescript
 * const eventStore = new InMemoryEventStore(logger);
 *
 * // Подписываемся на все события в EventBus
 * eventBus.subscribe('*', (event) => eventStore.append(event));
 *
 * // Получить все события
 * const allEvents = eventStore.getAll();
 *
 * // Получить события по типу
 * const placedEvents = eventStore.getByType('OrderPlaced');
 *
 * // Replay событий
 * eventStore.replay((event) => {
 *   console.log(`Replaying: ${event.eventName}`);
 * });
 * ```
 */

import type { DomainEvent } from '../../domain/events/DomainEvent.js';
import type { ILogger } from '../../domain/ports/ILogger.js';

/**
 * InMemoryEventStore class
 *
 * @remarks
 * Thread-safe для single-threaded JS (no synchronization needed).
 * Хранит события в памяти до явной очистки или перезапуска процесса.
 */
export class InMemoryEventStore {
  /**
   * In-memory storage for events (append-only)
   */
  private readonly events: DomainEvent[] = [];

  /**
   * Создаёт InMemoryEventStore
   *
   * @param logger - Logger для debugging
   *
   * @example
   * ```typescript
   * const logger = new ConsoleLogger();
   * const eventStore = new InMemoryEventStore(logger);
   * ```
   */
  constructor(private readonly logger: ILogger) {
    this.logger.debug('[EventStore] InMemoryEventStore initialized');
  }

  /**
   * Append event to store
   *
   * @param event - Domain event to store
   *
   * @remarks
   * Append-only operation (no updates/deletes).
   * Events are stored in order of append (not event timestamp).
   *
   * @example
   * ```typescript
   * const event = new OrderPlacedEvent(order);
   * eventStore.append(event);
   * ```
   */
  public append(event: DomainEvent): void {
    this.events.push(event);
    this.logger.debug(`[EventStore] Appended event: ${event.eventName} (${event.eventId})`);
  }

  /**
   * Получить все события
   *
   * @returns Все события в порядке добавления
   *
   * @example
   * ```typescript
   * const allEvents = eventStore.getAll();
   * console.log(`Total events: ${allEvents.length}`);
   * ```
   */
  public getAll(): DomainEvent[] {
    return [...this.events]; // return copy to prevent mutation
  }

  /**
   * Получить события по типу
   *
   * @param eventName - Название события (e.g., 'OrderPlaced')
   * @returns События указанного типа
   *
   * @example
   * ```typescript
   * const placedEvents = eventStore.getByType('OrderPlaced');
   * console.log(`Placed orders: ${placedEvents.length}`);
   * ```
   */
  public getByType(eventName: string): DomainEvent[] {
    return this.events.filter((e) => e.eventName === eventName);
  }

  /**
   * Получить события по aggregate ID
   *
   * @param aggregateId - ID агрегата (e.g., orderId)
   * @returns События для указанного агрегата
   *
   * @remarks
   * Для order events aggregateId = orderId.
   * Используется для восстановления состояния конкретного агрегата.
   *
   * @example
   * ```typescript
   * const orderEvents = eventStore.getByAggregateId('0x123abc');
   * // [OrderPlacedEvent, OrderFilledEvent, ...]
   * ```
   */
  public getByAggregateId(aggregateId: string): DomainEvent[] {
    return this.events.filter((e) => {
      // Проверяем несколько возможных полей для aggregateId
      const event = e as any;
      return (
        event.orderId === aggregateId ||
        event.order?.id === aggregateId ||
        event.aggregateId === aggregateId
      );
    });
  }

  /**
   * Получить события за временной период
   *
   * @param from - Начало периода
   * @param to - Конец периода (optional, default = now)
   * @returns События в указанном диапазоне
   *
   * @example
   * ```typescript
   * const last5Minutes = new Date(Date.now() - 5 * 60 * 1000);
   * const recentEvents = eventStore.getByTimeRange(last5Minutes);
   * ```
   */
  public getByTimeRange(from: Date, to: Date = new Date()): DomainEvent[] {
    return this.events.filter((e) => {
      const eventTime = e.timestamp.getTime();
      return eventTime >= from.getTime() && eventTime <= to.getTime();
    });
  }

  /**
   * Replay всех событий через callback
   *
   * @param handler - Функция обработки события
   *
   * @remarks
   * Используется для:
   * - Debugging (вывод всех событий)
   * - Testing (проверка последовательности событий)
   * - Восстановление состояния (event sourcing)
   *
   * @example
   * ```typescript
   * eventStore.replay((event) => {
   *   console.log(`${event.timestamp.toISOString()} - ${event.eventName}`);
   * });
   * ```
   */
  public replay(handler: (event: DomainEvent) => void): void {
    this.logger.debug(`[EventStore] Replaying ${this.events.length} events...`);

    for (const event of this.events) {
      try {
        handler(event);
      } catch (error) {
        this.logger.error(
          `[EventStore] Replay handler error for ${event.eventName}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    this.logger.debug(`[EventStore] Replay completed`);
  }

  /**
   * Очистить все события
   *
   * @remarks
   * Используется в тестах для сброса состояния.
   * В production не рекомендуется (потеря audit trail).
   *
   * @example
   * ```typescript
   * afterEach(() => {
   *   eventStore.clear();
   * });
   * ```
   */
  public clear(): void {
    this.events.length = 0;
    this.logger.debug('[EventStore] Store cleared');
  }

  /**
   * Получить статистику
   *
   * @returns Статистика по событиям
   *
   * @example
   * ```typescript
   * const stats = eventStore.getStats();
   * console.log(`Total: ${stats.totalEvents}`);
   * console.log(`By type:`, stats.eventsByType);
   * ```
   */
  public getStats(): {
    totalEvents: number;
    eventsByType: Record<string, number>;
    oldestEvent?: DomainEvent;
    newestEvent?: DomainEvent;
  } {
    const eventsByType: Record<string, number> = {};

    for (const event of this.events) {
      eventsByType[event.eventName] = (eventsByType[event.eventName] || 0) + 1;
    }

    return {
      totalEvents: this.events.length,
      eventsByType,
      oldestEvent: this.events[0],
      newestEvent: this.events[this.events.length - 1],
    };
  }

  /**
   * Получить размер store в байтах (приблизительно)
   *
   * @returns Приблизительный размер в байтах
   *
   * @remarks
   * Используется для мониторинга memory usage.
   * Приблизительная оценка через JSON serialization.
   */
  public getSizeInBytes(): number {
    const json = JSON.stringify(this.events.map((e) => e.toJSON()));
    return new Blob([json]).size;
  }
}
