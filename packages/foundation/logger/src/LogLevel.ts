/**
 * Уровни логирования
 *
 * @remarks
 * Определяет важность лог-сообщения. Уровни упорядочены по возрастанию важности:
 * TRACE < DEBUG < INFO < WARN < ERROR < FATAL
 *
 * Совместимо с Pino и другими популярными логгерами.
 *
 * ## Применение
 *
 * - **TRACE**: трассировка выполнения (вход/выход функций, промежуточные состояния)
 * - **DEBUG**: детальная отладочная информация (например, значения переменных)
 * - **INFO**: общая информация о работе системы (например, "Order placed")
 * - **WARN**: предупреждения о потенциальных проблемах (например, "Retry attempt 3/5")
 * - **ERROR**: ошибки требующие внимания (например, "Failed to connect to exchange")
 * - **FATAL**: критические ошибки приводящие к остановке (например, "Cannot start server")
 *
 * @example
 * ```typescript
 * const logger = new ConsoleLogger(clock, LogLevel.INFO);
 *
 * logger.trace('Entering function');   // Не логируется (TRACE < INFO)
 * logger.debug('Variable x = 42');     // Не логируется (DEBUG < INFO)
 * logger.info('Server started');       // ✅ Логируется
 * logger.warn('Connection slow');      // ✅ Логируется
 * logger.error('Database error', err); // ✅ Логируется
 * logger.fatal('Fatal error', err);    // ✅ Логируется
 * ```
 */
export enum LogLevel {
  /**
   * Трассировка выполнения
   *
   * @remarks
   * Самый детальный уровень логирования.
   * Используется для трассировки выполнения программы:
   * - Вход/выход из функций
   * - Промежуточные состояния в циклах
   * - Детали алгоритмов
   *
   * Обычно используется только при глубокой отладке.
   */
  TRACE = 'TRACE',

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

  /**
   * Критические ошибки
   *
   * @remarks
   * Фатальные ошибки которые приводят к остановке системы.
   * После логирования FATAL обычно следует завершение процесса.
   *
   * Примеры:
   * - Невозможность подключиться к exchange
   * - Критическая ошибка в risk management
   * - Потеря соединения с базой данных
   */
  FATAL = 'FATAL',
}

/**
 * Численные веса уровней для сравнения
 *
 * @remarks
 * Используется внутри логгера для фильтрации сообщений.
 * Меньший вес = более детальный уровень.
 *
 * Объект защищен от мутации через Object.freeze для предотвращения
 * случайных или злонамеренных изменений весов, которые могли бы сломать
 * фильтрацию логов во всем процессе.
 *
 * @internal
 */
export const LOG_LEVEL_WEIGHTS: Readonly<Record<LogLevel, number>> =
  Object.freeze({
    [LogLevel.TRACE]: 0,
    [LogLevel.DEBUG]: 1,
    [LogLevel.INFO]: 2,
    [LogLevel.WARN]: 3,
    [LogLevel.ERROR]: 4,
    [LogLevel.FATAL]: 5,
  } as const);

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
