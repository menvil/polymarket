/**
 * Опциональный observer диагностических событий MessageBus.
 *
 * @remarks
 * Foundation-примитив не зависит от logger: вместо этого потребитель может передать
 * observer в конструктор и направить уведомления в свой logger/metrics/telemetry.
 *
 * ### Гарантии изоляции
 * Observer только наблюдает:
 * - не участвует в control flow и не может изменить `Result` операций;
 * - уведомления best-effort;
 * - исключение самого observer'а перехватывается и НЕ влияет на доставку.
 *
 * Все callbacks опциональны.
 */

/**
 * Контекст падения обработчика.
 *
 * @remarks
 * Позволяет отличить: non-critical падение (`critical: false`), каноническую
 * (первую) critical-ошибку (`critical: true, primaryCritical: true`) и
 * дополнительные critical-ошибки того же сообщения
 * (`critical: true, primaryCritical: false`) — последние не возвращаются caller'у
 * и доступны только через observer.
 */
export interface HandlerErrorContext {
  /** Тип сообщения, на котором упал обработчик. */
  readonly messageType: string;
  /** Сырое брошенное значение обработчика. */
  readonly originalError: unknown;
  /** Был ли обработчик подписан с `{ critical: true }`. */
  readonly critical: boolean;
  /** Является ли ошибка канонической (первой critical) для этого сообщения. */
  readonly primaryCritical: boolean;
}

/** Контекст отклонения публикации по переполнению очереди. */
export interface QueueOverflowContext {
  /** Действовавший лимит очереди. */
  readonly maxQueueSize: number;
  /** Размер отклонённой публикации (1 для publish). */
  readonly attemptedCount: number;
  /** Размер ожидающей очереди на момент отклонения. */
  readonly queueSize: number;
  /** Тип сообщения — присутствует для одиночного publish. */
  readonly messageType?: string;
}

/** Контекст срабатывания drain-limit защиты. */
export interface DrainLimitContext {
  /** Действовавший лимит сообщений за drain-цикл. */
  readonly maxMessagesPerDrain: number;
  /** Сколько ожидавших сообщений очищено из очереди. */
  readonly clearedCount: number;
}

/**
 * Контракт observer'а. Все методы опциональны, вызовы best-effort.
 */
export interface MessageBusObserver {
  /** Падение обработчика (sync throw / async rejection, critical и non-critical). */
  onHandlerError?(context: HandlerErrorContext): void;
  /** Отклонение публикации по переполнению очереди. */
  onQueueOverflow?(context: QueueOverflowContext): void;
  /** Срабатывание drain-limit защиты (очередь петли очищена). */
  onDrainLimitExceeded?(context: DrainLimitContext): void;
}
