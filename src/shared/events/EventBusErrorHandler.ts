/**
 * EventBusErrorHandler - Интерфейс для обработки ошибок в EventBus
 *
 * @remarks
 * Определяет контракт для обработки ошибок, возникающих при вызове event handlers.
 *
 * Принципы:
 * - **Изоляция ошибок**: ошибка в одном handler не влияет на другие
 * - **Structured logging**: контекст ошибки для отладки
 * - **Не бросает exceptions**: обработчик ошибок не должен падать
 * - **Гибкость**: можно заменить реализацию (например, для тестов)
 *
 * @example
 * ```typescript
 * const errorHandler: EventBusErrorHandler = {
 *   handle(error, envelope, handlerName) {
 *     console.error('[EventBus] Handler error', {
 *       error: error instanceof Error ? error.message : String(error),
 *       eventType: envelope.type,
 *       eventId: envelope.id,
 *       handlerName,
 *       timestamp: envelope.timestamp.toISOString(),
 *     });
 *   }
 * };
 * ```
 */

import type { EventEnvelope } from './EventEnvelope.js';
import type { ILogger } from '../../domain/ports/ILogger.js';

/**
 * EventBusErrorHandler - Интерфейс обработчика ошибок
 *
 * @remarks
 * Вызывается когда handler бросает ошибку при обработке события.
 */
export interface EventBusErrorHandler {
  /**
   * Обрабатывает ошибку из event handler
   *
   * @param error - Ошибка, брошенная handler (может быть любого типа)
   * @param envelope - EventEnvelope, который обрабатывался
   * @param handlerName - Имя handler для debugging (обычно 'specific' или 'all')
   *
   * @remarks
   * Этот метод **НЕ должен бросать ошибки**.
   * Если обработчик ошибок падает, ошибка будет логироваться в console.error.
   *
   * Контекст для logging:
   * - `error`: само исключение (Error или unknown)
   * - `envelope.type`: тип события
   * - `envelope.id`: уникальный ID события
   * - `envelope.timestamp`: когда событие произошло
   * - `handlerName`: для различения specific vs all handlers
   *
   * @example
   * ```typescript
   * handle(error, envelope, handlerName) {
   *   logger.error('[EventBus] Handler failed', {
   *     error: error instanceof Error ? error.message : String(error),
   *     stack: error instanceof Error ? error.stack : undefined,
   *     eventType: envelope.type,
   *     eventId: envelope.id,
   *     handlerName,
   *     timestamp: envelope.timestamp.toISOString(),
   *   });
   * }
   * ```
   */
  handle(error: unknown, envelope: EventEnvelope<unknown>, handlerName: string): void;
}

/**
 * DefaultEventBusErrorHandler - Дефолтная реализация обработчика ошибок
 *
 * @remarks
 * Логирует ошибки через ILogger с structured форматом.
 * Использует минимальную error policy: только logging, никакого retry.
 *
 * @example
 * ```typescript
 * import { ConsoleLogger } from './infrastructure/logging/ConsoleLogger';
 *
 * const logger = new ConsoleLogger();
 * const errorHandler = new DefaultEventBusErrorHandler(logger);
 * const bus = new InMemoryEventBus(logger, errorHandler);
 * ```
 */
export class DefaultEventBusErrorHandler implements EventBusErrorHandler {
  /**
   * Logger для structured logging
   *
   * @remarks
   * Используется для логирования ошибок с полным контекстом.
   */
  private readonly logger: ILogger;

  /**
   * Создаёт DefaultEventBusErrorHandler
   *
   * @param logger - Logger для логирования ошибок
   *
   * @remarks
   * Logger должен быть передан извне (dependency injection).
   */
  constructor(logger: ILogger) {
    this.logger = logger;
  }

  /**
   * Обрабатывает ошибку через ILogger
   *
   * @param error - Ошибка из handler
   * @param envelope - EventEnvelope
   * @param handlerName - Имя handler
   *
   * @remarks
   * Минимальная error policy:
   * - Логирование ошибки с контекстом
   * - НЕТ retry
   * - НЕТ circuit breaker
   * - НЕТ dead letter queue
   *
   * Если logger упадёт - fallback на console.error.
   */
  public handle(error: unknown, envelope: EventEnvelope<unknown>, handlerName: string): void {
    // ВАЖНО: Обработчик ошибок НЕ должен падать
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Structured logging через ILogger
      this.logger.error('[EventBus] Handler error', {
        error: errorMessage,
        stack: errorStack,
        eventType: envelope.type,
        eventId: envelope.id,
        handlerName,
        timestamp: envelope.timestamp.toISOString(),
      });
    } catch (loggingError) {
      // Fallback: если даже logger упал
      console.error('[EventBus] Error in error handler:', loggingError);
      console.error('[EventBus] Original error:', error);
    }
  }
}
