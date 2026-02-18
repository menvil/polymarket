/**
 * Pino Logger Adapter - адаптер для production логирования
 *
 * @remarks
 * Адаптирует Pino logger к нашему ILogger интерфейсу.
 * Использует IClock для детерминированных timestamps (важно для paper trading).
 *
 * ## Особенности
 *
 * - Совместим с ILogger интерфейсом из @polymarket/logger
 * - Поддерживает IClock для детерминированного времени
 * - Корректная сериализация Error объектов через Pino { err: error }
 * - Поддержка child loggers с bindings
 * - Multiple transports (console, Datadog, CloudWatch, файлы)
 *
 * ## Использование
 *
 * ```typescript
 * const logger = new PinoLoggerAdapter(
 *   pino({ level: 'info' }),
 *   new LiveClock()
 * );
 *
 * logger.info('Order placed', { orderId: '123' });
 * ```
 */

import pino from 'pino';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';

export class PinoLoggerAdapter implements ILogger {
  private readonly pino: pino.Logger;

  /**
   * Системные поля Pino которые нельзя перезаписывать через context
   * @see https://getpino.io/#/docs/api?id=logger
   */
  private static readonly RESERVED_FIELDS = new Set([
    'time',    // Timestamp (контролируется через IClock)
    'msg',     // Message (передается отдельным параметром)
    'level',   // Log level (устанавливается методом trace/debug/info/etc)
    'pid',     // Process ID (автоматически добавляется Pino)
    'hostname',// Hostname (автоматически добавляется Pino)
    'err'      // Error object (управляется через параметр error)
  ]);

  /**
   * Создаёт Pino Logger Adapter
   *
   * @param optionsOrPino - Опции Pino logger или готовый pino.Logger (для child)
   * @param clock - Источник времени для timestamps
   * @param destination - Опциональный destination stream (для тестов)
   *
   * @remarks
   * IClock используется для генерации timestamp в логах.
   * Pino настраивается использовать IClock через custom timestamp function.
   * Это критично для paper trading режима где нужно детерминированное время.
   *
   * **ВАЖНО:** timestamp генерируется через IClock, не через Date.now().
   * В serialized JSON будет ОДНО поле "time" с значением из IClock.
   *
   * **Internal use:** Конструктор может принимать готовый pino.Logger для создания
   * child loggers через метод child(). В этом случае передается результат pino.child().
   *
   * @example
   * ```typescript
   * import { LiveClock } from '@polymarket/time';
   *
   * const logger = new PinoLoggerAdapter(
   *   { level: 'info' },
   *   new LiveClock()
   * );
   * ```
   */
  constructor(
    optionsOrPino: pino.LoggerOptions | pino.Logger,
    private readonly clock: IClock,
    destination?: pino.DestinationStream
  ) {
    // Type guard: проверяем есть ли метод child (признак pino.Logger)
    if ('child' in optionsOrPino && typeof optionsOrPino.child === 'function') {
      // Это готовый pino.Logger (для child loggers)
      this.pino = optionsOrPino;
    } else {
      // Это options (для новых loggers)
      // Настраиваем Pino использовать IClock для timestamp
      this.pino = pino({
        ...optionsOrPino,
        timestamp: () => `,"time":${this.clock.now().getTime()}`
      }, destination);
    }
  }

  /**
   * Фильтрует зарезервированные поля Pino из пользовательского context
   *
   * @param context - Пользовательский контекст
   * @returns Очищенный контекст без системных полей
   *
   * @remarks
   * Предотвращает коллизии с системными полями Pino (time, msg, level, etc.).
   * Если пользователь передаст { time: 123 }, это поле будет удалено из context.
   *
   * @example
   * ```typescript
   * sanitizeContext({ userId: '123', time: 999 })
   * // Результат: { userId: '123' }
   * ```
   */
  private sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> {
    if (!context) return {};

    const sanitized: Record<string, unknown> = {};
    try {
      const keys = Object.keys(context);
      for (const key of keys) {
        if (!PinoLoggerAdapter.RESERVED_FIELDS.has(key)) {
          try {
            // Читаем значение в отдельном try/catch — геттер может бросить исключение
            sanitized[key] = context[key];
          } catch (err) {
            // Геттер бросил исключение — сохраняем placeholder (аналогично foundation sanitizeContext)
            sanitized[key] = `[Error reading property: ${err instanceof Error ? err.message : String(err)}]`;
          }
        }
      }
    } catch {
      // Object.keys может упасть на Proxy или экзотичном объекте — возвращаем пустой объект
      return {};
    }
    return sanitized;
  }

  /**
   * Логирует трассировочное сообщение (уровень TRACE)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @example
   * ```typescript
   * logger.trace('Entering handleOrderbookUpdate', {
   *   marketId: '0xabc',
   *   bidsCount: 10
   * });
   * ```
   */
  trace(message: string, context?: Record<string, unknown>): void {
    this.pino.trace(this.sanitizeContext(context), message);
  }

  /**
   * Логирует отладочное сообщение (уровень DEBUG)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @example
   * ```typescript
   * logger.debug('Processing orderbook', {
   *   marketId: '0xabc',
   *   bids: 10,
   *   asks: 12
   * });
   * ```
   */
  debug(message: string, context?: Record<string, unknown>): void {
    this.pino.debug(this.sanitizeContext(context), message);
  }

  /**
   * Логирует информационное сообщение (уровень INFO)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @example
   * ```typescript
   * logger.info('Order placed successfully', {
   *   orderId: 'order-123',
   *   price: 0.65,
   *   quantity: 100
   * });
   * ```
   */
  info(message: string, context?: Record<string, unknown>): void {
    this.pino.info(this.sanitizeContext(context), message);
  }

  /**
   * Логирует предупреждение (уровень WARN)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст
   *
   * @example
   * ```typescript
   * logger.warn('Position limit approaching', {
   *   currentPosition: 450,
   *   limit: 500
   * });
   * ```
   */
  warn(message: string, context?: Record<string, unknown>): void {
    this.pino.warn(this.sanitizeContext(context), message);
  }

  /**
   * Логирует ошибку (уровень ERROR)
   *
   * @param message - Текст сообщения
   * @param error - Объект ошибки (опционально)
   * @param context - Дополнительный контекст
   *
   * @remarks
   * Pino ожидает Error объект в поле { err: error }.
   * Pino автоматически сериализует err.message, err.stack, etc.
   *
   * @example
   * ```typescript
   * try {
   *   await placeOrder(order);
   * } catch (error) {
   *   logger.error('Failed to place order', error as Error, {
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
    const pinoContext = {
      ...this.sanitizeContext(context),
      ...(error && { err: error }) // Pino автоматически сериализует err
    };
    this.pino.error(pinoContext, message);
  }

  /**
   * Логирует критическую ошибку (уровень FATAL)
   *
   * @param message - Текст сообщения
   * @param error - Объект ошибки (опционально)
   * @param context - Дополнительный контекст
   *
   * @remarks
   * FATAL используется для фатальных ошибок которые приводят к остановке.
   * После логирования FATAL обычно следует process.exit(1).
   *
   * @example
   * ```typescript
   * try {
   *   await connectToExchange();
   * } catch (error) {
   *   logger.fatal('Cannot connect to exchange', error as Error, {
   *     exchange: 'Polymarket',
   *     retryAttempts: 5
   *   });
   *   process.exit(1);
   * }
   * ```
   */
  fatal(
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void {
    const pinoContext = {
      ...this.sanitizeContext(context),
      ...(error && { err: error })
    };
    this.pino.fatal(pinoContext, message);
  }

  /**
   * Создаёт дочерний логгер с привязанным контекстом
   *
   * @param bindings - Контекст который будет добавлен ко всем логам
   * @returns Новый логгер с добавленным контекстом
   *
   * @remarks
   * Дочерний логгер наследует конфигурацию родителя и добавляет свой контекст.
   * Bindings автоматически фильтруются от системных полей Pino (time, msg, level, etc.)
   * через sanitizeContext(), предотвращая коллизии с системными полями.
   *
   * @example
   * ```typescript
   * const logger = new PinoLoggerAdapter({ level: 'info' }, new LiveClock());
   * const mmLogger = logger.child({ service: 'MarketMaker', marketId: '0xabc' });
   *
   * mmLogger.info('Quote sent', { price: 0.55 });
   * // Output включает: service="MarketMaker", marketId="0xabc", price=0.55
   *
   * // Системные поля фильтруются
   * const badLogger = logger.child({ time: 999, service: 'Test' });
   * badLogger.info('Message'); // time будет из IClock, не 999
   * ```
   */
  child(bindings: Record<string, unknown>): ILogger {
    // pino.child() наследует timestamp-функцию из замыкания родительского конструктора,
    // поэтому поле this.clock в дочернем PinoLoggerAdapter не влияет на генерацию timestamps —
    // оно передаётся для соответствия ILogger API и ясности намерений.
    return new PinoLoggerAdapter(
      this.pino.child(this.sanitizeContext(bindings)),
      this.clock
    );
  }
}
