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
 * - **Fail-safe**: никогда не бросает исключения, даже при circular references
 * - **Protected fields**: системные поля (timestamp, level, message) защищены от переопределения
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
import { safeStringify } from './utils/safeStringify.js';
import { sanitizeContext } from './utils/sanitizeContext.js';

/**
 * Сериализует Error из поля `err` в context в plain объект `{ message, name, stack }`.
 *
 * @remarks
 * JSON.stringify возвращает `{}` для Error (свойства non-enumerable).
 * Вызывается в `error()` и `fatal()` до передачи context в `log()`.
 */
function serializeErrorInContext(
  context?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!context || !(context.err instanceof Error)) return context;
  const { err, ...rest } = context;
  return { ...rest, err: { message: err.message, name: err.name, stack: err.stack } };
}

export class ConsoleLogger implements ILogger {
  /**
   * Создает logger для вывода в консоль
   *
   * @param clock - Источник времени для timestamps
   * @param level - Минимальный уровень логирования (по умолчанию INFO)
   * @param bindings - Контекст который добавляется ко всем логам (для child logger)
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
   *
   * // Child logger
   * const childLogger = new ConsoleLogger(clock, LogLevel.INFO, { service: 'MarketMaker' });
   * ```
   */
  constructor(
    private readonly clock: IClock,
    private readonly level: LogLevel = LogLevel.INFO,
    private readonly bindings: Record<string, unknown> = {}
  ) {}

  /**
   * Логирует трассировочное сообщение
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @remarks
   * Сообщение логируется только если уровень логгера <= TRACE.
   *
   * @example
   * ```typescript
   * logger.trace('Entering handleOrderbookUpdate', {
   *   marketId: '0xabc',
   *   bidsCount: 10,
   * });
   * ```
   */
  trace(message: string, context?: Record<string, unknown>): void {
    if (shouldLog(LogLevel.TRACE, this.level)) {
      this.log(LogLevel.TRACE, message, context);
    }
  }

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
   * @param context - Дополнительный контекст. Передавайте Error через `{ err: error }`
   *
   * @remarks
   * Сообщение логируется если уровень логгера <= ERROR.
   * Если в context передан `err: Error`, его message, name и stack будут сериализованы в лог.
   *
   * @example
   * ```typescript
   * try {
   *   await placeOrder(order);
   * } catch (err) {
   *   logger.error('Failed to place order', {
   *     err: err as Error,
   *     orderId: order.id,
   *   });
   * }
   * ```
   */
  error(message: string, context?: Record<string, unknown>): void {
    if (shouldLog(LogLevel.ERROR, this.level)) {
      this.log(LogLevel.ERROR, message, serializeErrorInContext(context));
    }
  }

  /**
   * Логирует критическую ошибку
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст. Передавайте Error через `{ err: error }`
   *
   * @remarks
   * Сообщение логируется если уровень логгера <= FATAL.
   * Используется для фатальных ошибок которые приводят к остановке системы.
   * После логирования FATAL обычно следует завершение процесса.
   *
   * @example
   * ```typescript
   * try {
   *   await connectToExchange();
   * } catch (err) {
   *   logger.fatal('Cannot connect to exchange', {
   *     err: err as Error,
   *     exchange: 'Polymarket',
   *     retryAttempts: 5,
   *   });
   *   process.exit(1);
   * }
   * ```
   */
  fatal(message: string, context?: Record<string, unknown>): void {
    if (shouldLog(LogLevel.FATAL, this.level)) {
      this.log(LogLevel.FATAL, message, serializeErrorInContext(context));
    }
  }

  /**
   * Создаёт дочерний логгер с привязанным контекстом
   *
   * @param bindings - Контекст который будет добавлен ко всем логам дочернего логгера
   * @returns Новый логгер с добавленным контекстом
   *
   * @remarks
   * Дочерний логгер наследует конфигурацию родителя (clock, level)
   * и объединяет bindings родителя и дочернего логгера.
   *
   * @example
   * ```typescript
   * const logger = new ConsoleLogger(clock, LogLevel.INFO);
   * const mmLogger = logger.child({ service: 'MarketMaker', marketId: '0xabc' });
   *
   * mmLogger.info('Quote sent', { price: 0.55 });
   * // Output: {"timestamp":"...","level":"INFO","service":"MarketMaker","marketId":"0xabc","message":"Quote sent","price":0.55}
   * ```
   */
  child(bindings: Record<string, unknown>): ILogger {
    return new ConsoleLogger(this.clock, this.level, {
      ...this.bindings,
      ...bindings,
    });
  }

  /**
   * Внутренний метод для форматирования и вывода лога
   *
   * @param level - Уровень сообщения
   * @param message - Текст сообщения
   * @param context - Контекст
   *
   * @remarks
   * Создает структурированный JSON объект с timestamp, level, message,
   * bindings (из child logger) и контекстом.
   *
   * Порядок слияния: bindings (от child) → context (от конкретного вызова)
   * Это позволяет context переопределять bindings если нужно.
   *
   * @internal
   */
  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>
  ): void {
    const timestamp = this.clock.now();

    // Sanitize bindings and context to prevent overriding reserved fields
    const sanitizedBindings = sanitizeContext(this.bindings);
    const sanitizedContext = context ? sanitizeContext(context) : {};

    const logEntry = {
      // System fields (protected from overriding)
      timestamp: timestamp.toISOString(),
      level,
      message,
      // User-provided context (sanitized)
      ...sanitizedBindings,
      ...sanitizedContext,
    };

    // Safe stringify - never throws
    const logString = safeStringify(logEntry);

    // Используем соответствующий метод console в зависимости от уровня
    switch (level) {
      case LogLevel.TRACE:
        console.debug(logString); // trace идёт в console.debug
        break;
      case LogLevel.DEBUG:
        console.debug(logString);
        break;
      case LogLevel.INFO:
        console.info(logString);
        break;
      case LogLevel.WARN:
        console.warn(logString);
        break;
      case LogLevel.ERROR:
        console.error(logString);
        break;
      case LogLevel.FATAL:
        console.error(logString); // fatal идёт в console.error
        break;
    }
  }
}
