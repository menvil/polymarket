/**
 * Интерфейс логгера для трейдинговой системы
 *
 * @remarks
 * Определяет контракт для structured logging с поддержкой разных уровней важности.
 * Логгер получает время через dependency injection (IClock), что обеспечивает
 * детерминированные timestamps в тестах и replay режиме.
 *
 * ## Принципы
 *
 * - **Structured logging**: все сообщения включают контекст (key-value пары)
 * - **Type-safe**: context типизирован как Record<string, unknown>
 * - **Dependency injection**: время берется из IClock
 * - **Уровни важности**: DEBUG, INFO, WARN, ERROR
 *
 * ## Реализации
 *
 * - **ConsoleLogger**: логирование в console (JSON формат)
 * - **NoOpLogger**: пустая реализация для тестов
 * - **FileLogger**: логирование в файл (TODO)
 *
 * @example
 * Использование в production:
 * ```typescript
 * import { ConsoleLogger, LogLevel } from '@polymarket/logger';
 * import { LiveClock } from '@polymarket/time';
 *
 * const logger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);
 *
 * logger.info('Order placed', {
 *   orderId: 'order-123',
 *   price: 0.65,
 *   quantity: 100,
 * });
 * // Output: {"timestamp":"2024-01-15T10:30:45.123Z","level":"INFO","message":"Order placed","orderId":"order-123","price":0.65,"quantity":100}
 * ```
 *
 * @example
 * Использование в тестах:
 * ```typescript
 * import { ConsoleLogger } from '@polymarket/logger';
 * import { PaperClock } from '@polymarket/time';
 *
 * const clock = new PaperClock(new Date('2024-01-01'));
 * const logger = new ConsoleLogger(clock, LogLevel.DEBUG);
 *
 * logger.info('Test message');
 * // Output с детерминированным timestamp: {"timestamp":"2024-01-01T00:00:00.000Z",...}
 *
 * clock.tick(1000);
 * logger.info('Second message');
 * // Output: {"timestamp":"2024-01-01T00:00:01.000Z",...}
 * ```
 */
export interface ILogger {
  /**
   * Логирует отладочное сообщение
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст (опционально)
   *
   * @remarks
   * Используется для детальной отладочной информации.
   * Обычно отключен в production (LogLevel.INFO и выше).
   *
   * @example
   * ```typescript
   * logger.debug('Processing order', {
   *   orderId: 'order-123',
   *   step: 'validation',
   *   inputData: { price: 0.65, quantity: 100 },
   * });
   * ```
   */
  debug(message: string, context?: Record<string, unknown>): void;

  /**
   * Логирует информационное сообщение
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст (опционально)
   *
   * @remarks
   * Используется для общей информации о нормальной работе системы.
   * Стандартный уровень для production.
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
  info(message: string, context?: Record<string, unknown>): void;

  /**
   * Логирует предупреждение
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст (опционально)
   *
   * @remarks
   * Используется для потенциальных проблем которые не являются ошибками.
   * Требуют внимания но не критичны.
   *
   * @example
   * ```typescript
   * logger.warn('Exchange connection slow', {
   *   latency: 2500,
   *   threshold: 1000,
   *   retryAttempt: 3,
   * });
   * ```
   */
  warn(message: string, context?: Record<string, unknown>): void;

  /**
   * Логирует ошибку
   *
   * @param message - Текст сообщения
   * @param error - Объект ошибки (опционально)
   * @param context - Дополнительный контекст (опционально)
   *
   * @remarks
   * Используется для ошибок требующих немедленного внимания.
   * Если передан Error, его stack trace будет включен в лог.
   *
   * @example
   * ```typescript
   * try {
   *   await placeOrder(order);
   * } catch (error) {
   *   logger.error('Failed to place order', error as Error, {
   *     orderId: order.id,
   *     price: order.price,
   *   });
   * }
   * ```
   */
  error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void;
}
