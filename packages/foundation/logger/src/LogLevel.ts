/**
 * Уровни логирования
 *
 * @remarks
 * Определяет важность лог-сообщения. Уровни упорядочены по возрастанию важности:
 * DEBUG < INFO < WARN < ERROR
 *
 * ## Применение
 *
 * - **DEBUG**: детальная отладочная информация (например, значения переменных)
 * - **INFO**: общая информация о работе системы (например, "Order placed")
 * - **WARN**: предупреждения о потенциальных проблемах (например, "Retry attempt 3/5")
 * - **ERROR**: ошибки требующие внимания (например, "Failed to connect to exchange")
 *
 * @example
 * ```typescript
 * const logger = new ConsoleLogger(clock, LogLevel.INFO);
 *
 * logger.debug('Variable x = 42');     // Не логируется (DEBUG < INFO)
 * logger.info('Server started');       // ✅ Логируется
 * logger.warn('Connection slow');      // ✅ Логируется
 * logger.error('Database error', err); // ✅ Логируется
 * ```
 */
export enum LogLevel {
  /**
   * Детальная отладочная информация
   *
   * @remarks
   * Используется для подробного трейсинга выполнения.
   * Обычно отключен в production.
   */
  DEBUG = 'DEBUG',

  /**
   * Информационные сообщения
   *
   * @remarks
   * Общая информация о нормальной работе системы.
   * Стандартный уровень для production.
   */
  INFO = 'INFO',

  /**
   * Предупреждения
   *
   * @remarks
   * Потенциальные проблемы которые не являются ошибками.
   * Требуют внимания но не критичны.
   */
  WARN = 'WARN',

  /**
   * Ошибки
   *
   * @remarks
   * Ошибки требующие немедленного внимания.
   * Обычно приводят к алертам в production.
   */
  ERROR = 'ERROR',
}

/**
 * Численные веса уровней для сравнения
 *
 * @remarks
 * Используется внутри логгера для фильтрации сообщений.
 *
 * @internal
 */
export const LOG_LEVEL_WEIGHTS: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

/**
 * Проверяет должно ли сообщение быть залогировано
 *
 * @param messageLevel - Уровень сообщения
 * @param configuredLevel - Настроенный минимальный уровень логгера
 * @returns true если сообщение должно быть залогировано
 *
 * @remarks
 * Сообщение логируется если его уровень >= настроенного уровня.
 *
 * @example
 * ```typescript
 * shouldLog(LogLevel.DEBUG, LogLevel.INFO); // false (DEBUG < INFO)
 * shouldLog(LogLevel.INFO, LogLevel.INFO);  // true  (INFO === INFO)
 * shouldLog(LogLevel.ERROR, LogLevel.INFO); // true  (ERROR > INFO)
 * ```
 */
export function shouldLog(
  messageLevel: LogLevel,
  configuredLevel: LogLevel
): boolean {
  return LOG_LEVEL_WEIGHTS[messageLevel] >= LOG_LEVEL_WEIGHTS[configuredLevel];
}
