/**
 * Интерфейс логгера для трейдинговой системы
 *
 * @remarks
 * Определяет контракт для structured logging с поддержкой разных уровней важности.
 * Логгер получает время через dependency injection (IClock), что обеспечивает
 * детерминированные timestamps в тестах, бэктестах и replay режиме.
 *
 * ## Принципы
 *
 * - **Structured logging**: все сообщения включают контекст (key-value пары)
 * - **Type-safe**: context типизирован как Record<string, unknown>
 * - **Dependency injection**: время берется из IClock
 * - **Уровни важности**: TRACE, DEBUG, INFO, WARN, ERROR, FATAL (6 уровней)
 * - **Child loggers**: поддержка контекстных логгеров
 *
 * ## Реализации
 *
 * - **ConsoleLogger**: JSON structured logging (для парсинга, CI/CD)
 * - **ColorConsoleLogger**: цветной human-readable вывод (для dev, бэктестов)
 * - **NoOpLogger**: пустая реализация для unit-тестов
 * - **PinoLoggerAdapter**: adapter для Pino (production, infrastructure layer)
 *
 * ## Уровни логирования (от детального к критичному)
 *
 * - **TRACE**: Трассировка выполнения (вход/выход из функций, промежуточные состояния)
 * - **DEBUG**: Детальная отладочная информация
 * - **INFO**: Информационные сообщения о нормальной работе (по умолчанию в production)
 * - **WARN**: Предупреждения о потенциальных проблемах
 * - **ERROR**: Ошибки требующие внимания
 * - **FATAL**: Критические ошибки приводящие к остановке системы
 *
 * @example
 * Использование в production (Pino):
 * ```typescript
 * import { PinoLoggerAdapter } from '@/infrastructure/adapters/PinoLoggerAdapter';
 * import { LiveClock } from '@polymarket/time';
 * import pino from 'pino';
 *
 * const logger = new PinoLoggerAdapter(pino(), new LiveClock());
 *
 * logger.info('Order placed', {
 *   orderId: 'order-123',
 *   price: 0.65,
 *   quantity: 100,
 * });
 * ```
 *
 * @example
 * Использование в бэктестах (детерминированное время):
 * ```typescript
 * import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
 * import { PaperClock } from '@polymarket/time';
 *
 * const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
 * const logger = new ColorConsoleLogger(clock, LogLevel.DEBUG);
 *
 * logger.info('Backtest started');
 * // [2024-01-01T00:00:00.000Z] [INFO] Backtest started
 *
 * clock.tick(60000); // +1 минута симуляции
 * logger.info('First trade executed');
 * // [2024-01-01T00:01:00.000Z] [INFO] First trade executed
 * ```
 *
 * @example
 * Child loggers для контекста:
 * ```typescript
 * const logger = new ColorConsoleLogger(clock, LogLevel.INFO);
 * const mmLogger = logger.child({ service: 'MarketMaker' });
 * const riskLogger = logger.child({ service: 'RiskManager' });
 *
 * mmLogger.info('Quote sent');
 * // [INFO] [service=MarketMaker] Quote sent
 *
 * riskLogger.warn('Position limit approaching');
 * // [WARN] [service=RiskManager] Position limit approaching
 * ```
 */
export interface ILogger {
  /**
   * Логирует трассировочное сообщение (уровень TRACE)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительный контекст (опционально)
   *
   * @remarks
   * Уровень TRACE - самый детальный уровень логирования.
   * Используется для трассировки выполнения программы:
   * - Вход/выход из функций
   * - Промежуточные состояния
   * - Детали алгоритмов
   *
   * Обычно используется только при глубокой отладке.
   *
   * @example
   * ```typescript
   * logger.trace('Entering handleOrderbookUpdate', {
   *   marketId: '0xabc',
   *   bidsCount: 10,
   *   asksCount: 12,
   * });
   * ```
   */
  trace(message: string, context?: Record<string, unknown>): void;

  /**
   * Логирует отладочное сообщение (уровень DEBUG)
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
   * Логирует информационное сообщение (уровень INFO)
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
   * Логирует предупреждение (уровень WARN)
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
   * Логирует ошибку (уровень ERROR)
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

  /**
   * Логирует критическую ошибку (уровень FATAL)
   *
   * @param message - Текст сообщения
   * @param error - Объект ошибки (опционально)
   * @param context - Дополнительный контекст (опционально)
   *
   * @remarks
   * Уровень FATAL - самый критичный уровень логирования.
   * Используется для фатальных ошибок которые приводят к остановке системы:
   * - Невозможность подключиться к exchange
   * - Критическая ошибка в risk management
   * - Потеря соединения с базой данных
   *
   * После логирования FATAL обычно следует завершение процесса.
   *
   * @example
   * ```typescript
   * try {
   *   await connectToExchange();
   * } catch (error) {
   *   logger.fatal('Cannot connect to exchange', error as Error, {
   *     exchange: 'Polymarket',
   *     retryAttempts: 5,
   *   });
   *   process.exit(1);
   * }
   * ```
   */
  fatal(
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void;

  /**
   * Создаёт дочерний логгер с привязанным контекстом
   *
   * @param bindings - Контекст который будет добавлен ко всем логам дочернего логгера
   * @returns Новый логгер с добавленным контекстом
   *
   * @remarks
   * Child logger наследует конфигурацию родителя (уровень, форматирование)
   * и добавляет свой контекст ко всем сообщениям.
   *
   * Полезно для:
   * - Идентификации источника лога (service, component)
   * - Добавления постоянного контекста (userId, sessionId, tradeId)
   * - Создания иерархических логгеров
   *
   * @example
   * ```typescript
   * const logger = new ColorConsoleLogger(clock, LogLevel.INFO);
   *
   * // Логгер для MarketMaker сервиса
   * const mmLogger = logger.child({ service: 'MarketMaker', marketId: '0xabc' });
   * mmLogger.info('Quote sent', { price: 0.55 });
   * // [INFO] [service=MarketMaker] [marketId=0xabc] Quote sent { price: 0.55 }
   *
   * // Вложенный логгер для конкретного ордера
   * const orderLogger = mmLogger.child({ orderId: 'order-123' });
   * orderLogger.debug('Order validation started');
   * // [DEBUG] [service=MarketMaker] [marketId=0xabc] [orderId=order-123] Order validation started
   * ```
   */
  child(bindings: Record<string, unknown>): ILogger;
}
