/**
 * Реализация логгера для вывода в console
 *
 * @remarks
 * Логирует сообщения в консоль в структурированном JSON формате.
 * Использует IClock для получения детерминированных timestamps.
 *
 * ## Характеристики
 *
 * - **Structured logging**: каждое сообщение - JSON объект
 * - **Детерминированные timestamps**: через IClock dependency injection
 * - **Фильтрация по уровню**: логируются только сообщения >= настроенного уровня
 * - **Stack traces**: автоматически включаются для ошибок
 *
 * ## Формат вывода
 *
 * ```json
 * {
 *   "timestamp": "2024-01-15T10:30:45.123Z",
 *   "level": "INFO",
 *   "message": "Order placed",
 *   "orderId": "order-123",
 *   "price": 0.65
 * }
 * ```
 *
 * @example
 * Production использование:
 * ```typescript
 * import { ConsoleLogger, LogLevel } from '@polymarket/logger';
 * import { LiveClock } from '@polymarket/time';
 *
 * const logger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);
 *
 * logger.info('Server started', { port: 3000 });
 * logger.warn('High latency detected', { latency: 2500 });
 * logger.error('Database connection failed', dbError);
 * ```
 *
 * @example
 * Тестирование с PaperClock:
 * ```typescript
 * import { ConsoleLogger, LogLevel } from '@polymarket/logger';
 * import { PaperClock } from '@polymarket/time';
 *
 * const clock = new PaperClock(new Date('2024-01-01'));
 * const logger = new ConsoleLogger(clock, LogLevel.DEBUG);
 *
 * logger.info('Test message');
 * // Timestamp будет детерминированным: "2024-01-01T00:00:00.000Z"
 * ```
 */

import type { IClock } from '@polymarket/time';
import type { ILogger } from './ILogger.js';
import { LogLevel, shouldLog } from './LogLevel.js';

export class ConsoleLogger implements ILogger {
  /**
   * Создает logger для вывода в консоль
   *
   * @param clock - Источник времени для timestamps
   * @param level - Минимальный уровень логирования (по умолчанию INFO)
   *
   * @remarks
   * Clock предоставляется через dependency injection для обеспечения
   * детерминированных timestamps в тестах и replay режиме.
   *
   * @example
   * ```typescript
   * // Production
   * const logger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);
   *
   * // Testing
   * const logger = new ConsoleLogger(new PaperClock(new Date()), LogLevel.DEBUG);
   *
   * // Replay
   * const logger = new ConsoleLogger(new ReplayClock(new Date(0)), LogLevel.INFO);
   * ```
   */
  constructor(
    private readonly clock: IClock,
    private readonly level: LogLevel = LogLevel.INFO
  ) {}

  /**
   * Логирует отладочное сообщение
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @remarks
   * Сообщение логируется только если уровень логгера <= DEBUG.
   *
   * @example
   * ```typescript
   * logger.debug('Order validation started', {
   *   orderId: 'order-123',
   *   step: 'validate-price',
   * });
   * ```
   */
  debug(message: string, context?: Record<string, unknown>): void {
    if (shouldLog(LogLevel.DEBUG, this.level)) {
      this.log(LogLevel.DEBUG, message, context);
    }
  }

  /**
   * Логирует информационное сообщение
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @remarks
   * Сообщение логируется если уровень логгера <= INFO.
   *
   * @example
   * ```typescript
   * logger.info('Order placed successfully', {
   *   orderId: 'order-123',
   *   price: 0.65,
   *   quantity: 100,
   * });
   * ```
   */
  info(message: string, context?: Record<string, unknown>): void {
    if (shouldLog(LogLevel.INFO, this.level)) {
      this.log(LogLevel.INFO, message, context);
    }
  }

  /**
   * Логирует предупреждение
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @remarks
   * Сообщение логируется если уровень логгера <= WARN.
   *
   * @example
   * ```typescript
   * logger.warn('Exchange connection slow', {
   *   latency: 2500,
   *   threshold: 1000,
   * });
   * ```
   */
  warn(message: string, context?: Record<string, unknown>): void {
    if (shouldLog(LogLevel.WARN, this.level)) {
      this.log(LogLevel.WARN, message, context);
    }
  }

  /**
   * Логирует ошибку
   *
   * @param message - Текст сообщения
   * @param error - Объект ошибки (опционально)
   * @param context - Дополнительный контекст
   *
   * @remarks
   * Сообщение логируется если уровень логгера <= ERROR.
   * Если передан Error, его message и stack будут включены в лог.
   *
   * @example
   * ```typescript
   * try {
   *   await placeOrder(order);
   * } catch (err) {
   *   logger.error('Failed to place order', err as Error, {
   *     orderId: order.id,
   *   });
   * }
   * ```
   */
  error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void {
    if (shouldLog(LogLevel.ERROR, this.level)) {
      const errorContext = error
        ? {
            error: {
              message: error.message,
              name: error.name,
              stack: error.stack,
            },
          }
        : {};

      this.log(LogLevel.ERROR, message, { ...context, ...errorContext });
    }
  }

  /**
   * Внутренний метод для форматирования и вывода лога
   *
   * @param level - Уровень сообщения
   * @param message - Текст сообщения
   * @param context - Контекст
   *
   * @remarks
   * Создает структурированный JSON объект с timestamp, level, message и контекстом.
   *
   * @internal
   */
  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>
  ): void {
    const timestamp = this.clock.now();

    const logEntry = {
      timestamp: timestamp.toISOString(),
      level,
      message,
      ...context,
    };

    // Используем соответствующий метод console в зависимости от уровня
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(JSON.stringify(logEntry));
        break;
      case LogLevel.INFO:
        console.info(JSON.stringify(logEntry));
        break;
      case LogLevel.WARN:
        console.warn(JSON.stringify(logEntry));
        break;
      case LogLevel.ERROR:
        console.error(JSON.stringify(logEntry));
        break;
    }
  }
}
