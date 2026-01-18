/**
 * InMemoryEventStore - хранилище событий в памяти
 *
 * @remarks
 * Простая реализация EventStore для хранения истории всех domain events.
 *
 * Возможности:
 * - Сохранение всех событий в памяти (массив)
 * - Поиск событий по типу/идентификатору агрегата/временному диапазону
 * - Воспроизведение событий (для отладки и тестирования)
 * - Очистка хранилища (для тестов)
 *
 * Используется для:
 * - Отладка (просмотр истории событий)
 * - Тестирование (воспроизведение сценариев)
 * - Журнал аудита (кто/что/когда)
 * - Источник событий (восстановление состояния из событий)
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
 * Класс InMemoryEventStore
 *
 * @remarks
 * Потокобезопасен для однопоточного JS (синхронизация не требуется).
 * Хранит события в памяти до явной очистки или перезапуска процесса.
 */
export class InMemoryEventStore {
  /**
   * Хранилище событий в памяти (только добавление)
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
   * Добавить событие в хранилище
   *
   * @param event - Доменное событие для сохранения
   *
   * @remarks
   * Операция только добавления (без обновлений/удалений).
   * События хранятся в порядке добавления (не по временной метке события).
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
    return [...this.events]; // возвращаем копию для предотвращения мутации
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
   *
   * Совместимость:
   * - Browser: TextEncoder (стандартный API)
   * - Node.js: Buffer.byteLength (fallback)
   * - Graceful handling: если event не имеет toJSON, используется сам объект
   */
  public getSizeInBytes(): number {
    // Безопасная сериализация: toJSON() если есть, иначе сам объект
    const serializable = this.events.map((e) =>
      typeof e.toJSON === 'function' ? e.toJSON() : e
    );
    const json = JSON.stringify(serializable);

    // TextEncoder доступен в браузерах и Node.js 11+
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(json).length;
    }

    // Fallback для старых версий Node.js
    if (typeof Buffer !== 'undefined') {
      return Buffer.byteLength(json, 'utf8');
    }

    // Последний fallback: приблизительная оценка (ASCII = 1 байт на символ)
    return json.length;
  }
}
