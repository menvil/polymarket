/**
 * ILogger port
 *
 * @remarks
 * Интерфейс для логирования.
 * Реализация находится в infrastructure layer (Winston, Pino, console и т.д.).
 *
 * Responsibilities:
 * - Логирование на разных уровнях
 * - Структурированное логирование (metadata)
 * - Форматирование сообщений
 *
 * @example
 * ```typescript
 * class ConsoleLogger implements ILogger {
 *   info(message: string, metadata?: any): void {
 *     console.log('[INFO]', message, metadata);
 *   }
 * }
 * ```
 */

/**
 * Logger interface
 *
 * @remarks
 * Простой интерфейс логгера совместимый с популярными библиотеками.
 */
export interface ILogger {
  /**
   * Логирует самое детальное сообщение (уровень SILLY)
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные (опционально)
   *
   * @remarks
   * Уровень SILLY (самый низкий):
   * - Максимально детальная информация
   * - Используется для глубокой отладки
   * - Включает внутренние детали реализации
   * - Пример: "Parsing level: price=0.52, size=100"
   */
  silly(message: string, metadata?: any): void;

  /**
   * Логирует трассировочное сообщение (уровень TRACE)
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные (опционально)
   *
   * @remarks
   * Уровень TRACE (очень детальный):
   * - Трассировка выполнения программы
   * - Вход/выход из функций
   * - Промежуточные состояния
   * - Пример: "Entering handleOrderbookUpdate", "Processing 10 bids"
   */
  trace(message: string, metadata?: any): void;

  /**
   * Логирует отладочное сообщение
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные (опционально)
   *
   * @remarks
   * Уровень DEBUG:
   * - Детальная информация для отладки
   * - Не логируется в production (обычно)
   * - Пример: "Received orderbook update: 10 bids, 12 asks"
   */
  debug(message: string, metadata?: any): void;

  /**
   * Логирует информационное сообщение
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные (опционально)
   *
   * @remarks
   * Уровень INFO:
   * - Важные события в нормальном потоке
   * - Логируется в production
   * - Пример: "Order placed: BUY 100 @ 0.65"
   */
  info(message: string, metadata?: any): void;

  /**
   * Логирует предупреждение
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные (опционально)
   *
   * @remarks
   * Уровень WARN:
   * - Потенциальные проблемы
   * - Не критично, но требует внимания
   * - Пример: "Orderbook is stale (5s old)"
   */
  warn(message: string, metadata?: any): void;

  /**
   * Логирует ошибку
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные (опционально, обычно Error object)
   *
   * @remarks
   * Уровень ERROR:
   * - Критические ошибки
   * - Требует немедленного внимания
   * - Пример: "Failed to place order", { error: Error, orderId: '123' }
   */
  error(message: string, metadata?: any): void;

  /**
   * Создаёт дочерний логгер с контекстом
   *
   * @param context - Контекст (например, имя сервиса/модуля)
   * @returns Новый логгер с добавленным контекстом
   *
   * @remarks
   * - Все сообщения дочернего логгера будут включать context
   * - Полезно для идентификации источника лога
   * - Пример: logger.child('MarketMaker').info('Started') → "[MarketMaker] Started"
   */
  child?(context: string): ILogger;
}
