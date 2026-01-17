/**
 * DomainEvent - базовый класс для доменных событий
 *
 * @remarks
 * Доменные события представляют факты, которые произошли в системе.
 * События иммутабельны и всегда описывают прошедшее время.
 *
 * Принципы Domain Events:
 * - Иммутабельность: события нельзя изменить после создания
 * - Прошедшее время: события описывают то, что УЖЕ произошло
 * - Факты: события - это записи о фактах, а не команды
 * - Timestamp: каждое событие имеет временную метку
 *
 * Зачем нужны Domain Events?
 * - Децентрализация логики (loose coupling)
 * - Event sourcing (восстановление состояния из событий)
 * - Аудит и логирование
 * - Интеграция с внешними системами
 *
 * @example
 * ```typescript
 * class OrderPlacedEvent extends DomainEvent {
 *   constructor(
 *     public readonly orderId: string,
 *     public readonly price: Price,
 *     timestamp: Date = new Date()
 *   ) {
 *     super('OrderPlaced', timestamp);
 *   }
 * }
 *
 * const event = new OrderPlacedEvent('order-123', Price.fromNumber(0.65));
 * console.log(event.eventName); // 'OrderPlaced'
 * console.log(event.timestamp); // Date
 * console.log(event.eventId); // Unique ID
 * ```
 */

/**
 * DomainEvent base class
 *
 * @remarks
 * Абстрактный базовый класс для всех доменных событий.
 * Предоставляет общие поля: eventName, eventId, timestamp.
 */
export abstract class DomainEvent {
  /**
   * Unique event identifier
   */
  public readonly eventId: string;

  /**
   * Creates a DomainEvent
   *
   * @param eventName - Name of the event (e.g., 'OrderFilled')
   * @param timestamp - When the event occurred
   *
   * @remarks
   * Автоматически генерирует уникальный eventId.
   *
   * @example
   * ```typescript
   * class MyEvent extends DomainEvent {
   *   constructor(public readonly data: string) {
   *     super('MyEvent', new Date());
   *   }
   * }
   * ```
   */
  constructor(
    public readonly eventName: string,
    public readonly timestamp: Date
  ) {
    this.eventId = this.generateEventId();
  }

  /**
   * Generates unique event ID
   *
   * @returns Unique identifier for this event
   *
   * @remarks
   * Формат: `{eventName}-{timestamp}-{random}`
   */
  private generateEventId(): string {
    const ts = this.timestamp.getTime();
    const random = Math.random().toString(36).substring(2, 9);
    return `${this.eventName}-${ts}-${random}`;
  }

  /**
   * Converts event to plain object
   *
   * @returns Plain object representation
   *
   * @remarks
   * Useful for serialization (JSON, database storage).
   *
   * @example
   * ```typescript
   * const event = new OrderFilledEvent('order-123', ...);
   * const json = JSON.stringify(event.toJSON());
   * ```
   */
  public toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventName: this.eventName,
      timestamp: this.timestamp.toISOString(),
      ...this.getData(),
    };
  }

  /**
   * Gets event-specific data
   *
   * @returns Event data as plain object
   *
   * @remarks
   * Override this method in subclasses to include event-specific data.
   *
   * @example
   * ```typescript
   * class OrderFilledEvent extends DomainEvent {
   *   constructor(public readonly orderId: string) {
   *     super('OrderFilled', new Date());
   *   }
   *
   *   protected getData() {
   *     return { orderId: this.orderId };
   *   }
   * }
   * ```
   */
  protected getData(): Record<string, unknown> {
    return {};
  }

  /**
   * String representation of event
   *
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * const event = new OrderFilledEvent('order-123', ...);
   * console.log(event.toString());
   * // 'OrderFilledEvent[order-123] at 2024-01-01T00:00:00.000Z'
   * ```
   */
  public toString(): string {
    return `${this.eventName}[${this.eventId}] at ${this.timestamp.toISOString()}`;
  }
}
