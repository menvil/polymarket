/**
 * Color Console Logger - реализация ILogger с цветным выводом
 *
 * @remarks
 * Логгер с human-readable цветным выводом для локальной разработки и бэктестов.
 * Поддерживает:
 * - 6 уровней логирования (trace, debug, info, warn, error, fatal)
 * - Цветной вывод для разных уровней
 * - Timestamps из IClock (детерминированные для тестов/бэктестов)
 * - Структурированные метаданные
 * - Child loggers с контекстом
 *
 * ## Уровни логирования (от самого детального к критичному)
 *
 * - trace: Трассировка выполнения (вход/выход из функций)
 * - debug: Отладочная информация
 * - info: Информационные сообщения
 * - warn: Предупреждения
 * - error: Ошибки
 * - fatal: Критические ошибки приводящие к остановке
 *
 * ## Алгоритм логирования
 *
 * 1. Форматирует сообщение с timestamp и уровнем
 * 2. Добавляет контекст из bindings (если это child logger)
 * 3. Применяет цветовое кодирование
 * 4. Выводит в console.log/warn/error
 * 5. Добавляет metadata если присутствуют
 *
 * ## Формат вывода
 *
 * ```
 * [2024-01-15T10:30:45.123Z] [INFO] [service=MarketMaker] Message { metadata }
 * ```
 *
 * @example
 * Использование в бэктестах:
 * ```typescript
 * import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
 * import { PaperClock } from '@polymarket/time';
 *
 * const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
 * const logger = new ColorConsoleLogger(clock, LogLevel.DEBUG);
 *
 * logger.trace('Entering handleMessage');
 * logger.debug('Fetching orderbook', { marketId: '0xabc' });
 * logger.info('Trading bot started');
 * logger.warn('High position detected', { netPosition: 500 });
 * logger.error('Failed to place order', new Error('Network error'));
 * logger.fatal('Cannot connect to exchange', new Error('Connection refused'));
 * ```
 *
 * @example
 * Child logger с контекстом:
 * ```typescript
 * const logger = new ColorConsoleLogger(clock, LogLevel.INFO);
 * const mmLogger = logger.child({ service: 'MarketMaker' });
 *
 * mmLogger.info('Quote sent'); // [INFO] [service=MarketMaker] Quote sent
 * ```
 */

import type { IClock } from '@polymarket/time';
import type { ILogger } from './ILogger.js';
import { LogLevel, shouldLog } from './LogLevel.js';
import { safeStringify } from './utils/safeStringify.js';
import { sanitizeContext } from './utils/sanitizeContext.js';

/**
 * ANSI color codes для консоли
 */
const COLORS = {
  reset: '\x1b[0m',
  trace: '\x1b[94m', // Light Blue
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m', // Green
  warn: '\x1b[33m', // Yellow
  error: '\x1b[31m', // Red
  fatal: '\x1b[35m', // Magenta (ярко-красный для критичных)
  timestamp: '\x1b[90m', // Gray
  context: '\x1b[35m', // Magenta
} as const;

/**
 * Color Console Logger
 *
 * @remarks
 * Реализация ILogger для вывода в консоль с цветным форматированием.
 * Использует IClock для детерминированных timestamps в бэктестах.
 */
export class ColorConsoleLogger implements ILogger {
  /**
   * Создаёт новый Color Console Logger
   *
   * @param clock - Источник времени для timestamps
   * @param level - Минимальный уровень логирования (по умолчанию INFO)
   * @param bindings - Контекст который добавляется ко всем логам (для child logger)
   * @param useColors - Использовать цветовое кодирование (по умолчанию true)
   * @param showTimestamp - Показывать timestamp (по умолчанию true)
   * @param showMetadata - Показывать metadata (по умолчанию true)
   *
   * @remarks
   * Clock предоставляется через dependency injection для детерминированных timestamps.
   *
   * @example
   * ```typescript
   * // Бэктест с цветным выводом
   * const clock = new PaperClock(new Date('2024-01-01'));
   * const logger = new ColorConsoleLogger(clock, LogLevel.DEBUG);
   *
   * // Production с LiveClock
   * const logger = new ColorConsoleLogger(new LiveClock(), LogLevel.INFO);
   *
   * // Без цветов (для CI/CD)
   * const logger = new ColorConsoleLogger(clock, LogLevel.INFO, {}, false);
   * ```
   */
  constructor(
    private readonly clock: IClock,
    private readonly level: LogLevel = LogLevel.INFO,
    private readonly bindings: Record<string, unknown> = {},
    private readonly useColors: boolean = true,
    private readonly showTimestamp: boolean = true,
    private readonly showMetadata: boolean = true
  ) {}

  /**
   * Логирует трассировочное сообщение (уровень TRACE)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительные данные
   *
   * @remarks
   * Уровень TRACE: трассировка выполнения программы.
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
    if (shouldLog(LogLevel.TRACE, this.level)) {
      this.log(LogLevel.TRACE, message, context);
    }
  }

  /**
   * Логирует отладочное сообщение (уровень DEBUG)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительные данные
   *
   * @remarks
   * Уровень DEBUG: детальная информация для отладки.
   *
   * @example
   * ```typescript
   * logger.debug('Orderbook received', {
   *   marketId: '0xabc',
   *   bids: 10,
   *   asks: 12
   * });
   * ```
   */
  debug(message: string, context?: Record<string, unknown>): void {
    if (shouldLog(LogLevel.DEBUG, this.level)) {
      this.log(LogLevel.DEBUG, message, context);
    }
  }

  /**
   * Логирует информационное сообщение (уровень INFO)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительные данные
   *
   * @remarks
   * Уровень INFO: важные события в нормальном потоке.
   *
   * @example
   * ```typescript
   * logger.info('Order placed', {
   *   orderId: '0x123',
   *   side: 'BUY',
   *   price: 0.55,
   *   size: 100
   * });
   * ```
   */
  info(message: string, context?: Record<string, unknown>): void {
    if (shouldLog(LogLevel.INFO, this.level)) {
      this.log(LogLevel.INFO, message, context);
    }
  }

  /**
   * Логирует предупреждение (уровень WARN)
   *
   * @param message - Текст сообщения
   * @param context - Дополнительные данные
   *
   * @remarks
   * Уровень WARN: потенциальные проблемы, не критичные.
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
    if (shouldLog(LogLevel.WARN, this.level)) {
      this.log(LogLevel.WARN, message, context);
    }
  }

  /**
   * Логирует ошибку (уровень ERROR)
   *
   * @param message - Текст сообщения
   * @param error - Объект ошибки (опционально)
   * @param context - Дополнительные данные
   *
   * @remarks
   * Уровень ERROR: критические ошибки.
   *
   * @example
   * ```typescript
   * logger.error('Failed to cancel order', new Error('Timeout'), {
   *   orderId: '0x123'
   * });
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
   * Логирует критическую ошибку (уровень FATAL)
   *
   * @param message - Текст сообщения
   * @param error - Объект ошибки (опционально)
   * @param context - Дополнительные данные
   *
   * @remarks
   * Уровень FATAL: фатальные ошибки приводящие к остановке.
   *
   * @example
   * ```typescript
   * logger.fatal('Cannot connect to exchange', new Error('Connection refused'), {
   *   exchange: 'Polymarket',
   *   retryAttempts: 5
   * });
   * process.exit(1);
   * ```
   */
  fatal(
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void {
    if (shouldLog(LogLevel.FATAL, this.level)) {
      const errorContext = error
        ? {
            error: {
              message: error.message,
              name: error.name,
              stack: error.stack,
            },
          }
        : {};

      this.log(LogLevel.FATAL, message, { ...context, ...errorContext });
    }
  }

  /**
   * Создаёт дочерний логгер с контекстом
   *
   * @param bindings - Контекст который будет добавлен ко всем логам
   * @returns Новый логгер с добавленным контекстом
   *
   * @remarks
   * Дочерний логгер наследует конфигурацию родителя.
   * Все сообщения будут включать указанный контекст.
   *
   * @example
   * ```typescript
   * const logger = new ColorConsoleLogger(clock, LogLevel.INFO);
   * const mmLogger = logger.child({ service: 'MarketMaker' });
   * const riskLogger = logger.child({ service: 'RiskManager' });
   *
   * mmLogger.info('Started'); // [INFO] [service=MarketMaker] Started
   * riskLogger.warn('Limit exceeded'); // [WARN] [service=RiskManager] Limit exceeded
   * ```
   */
  child(bindings: Record<string, unknown>): ILogger {
    return new ColorConsoleLogger(
      this.clock,
      this.level,
      { ...this.bindings, ...bindings },
      this.useColors,
      this.showTimestamp,
      this.showMetadata
    );
  }

  /**
   * Основной метод логирования
   *
   * @param level - Уровень лога
   * @param message - Сообщение
   * @param context - Контекст
   *
   * @remarks
   * Алгоритм:
   * 1. Форматирует timestamp из IClock
   * 2. Форматирует level с цветами
   * 3. Добавляет контекст из bindings (child logger)
   * 4. Добавляет контекст из вызова
   * 5. Форматирует metadata
   * 6. Выводит в соответствующий console метод
   *
   * @internal
   */
  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>
  ): void {
    // Sanitize bindings and context to prevent overriding reserved fields
    const sanitizedBindings = sanitizeContext(this.bindings);
    const sanitizedContext = context ? sanitizeContext(context) : undefined;

    // Форматируем сообщение
    const parts: string[] = [];

    // Timestamp
    if (this.showTimestamp) {
      const timestamp = this.clock.now().toISOString();
      if (this.useColors) {
        parts.push(`${COLORS.timestamp}[${timestamp}]${COLORS.reset}`);
      } else {
        parts.push(`[${timestamp}]`);
      }
    }

    // Level
    const levelStr = level.toUpperCase();
    if (this.useColors) {
      const color = COLORS[level.toLowerCase() as keyof typeof COLORS];
      parts.push(`${color}[${levelStr}]${COLORS.reset}`);
    } else {
      parts.push(`[${levelStr}]`);
    }

    // Bindings (от child logger) - sanitized
    if (Object.keys(sanitizedBindings).length > 0) {
      const bindingsStr = Object.entries(sanitizedBindings)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');

      if (this.useColors) {
        parts.push(`${COLORS.context}[${bindingsStr}]${COLORS.reset}`);
      } else {
        parts.push(`[${bindingsStr}]`);
      }
    }

    // Message
    parts.push(message);

    // Формируем итоговую строку
    let logMessage = parts.join(' ');

    // Context/Metadata - sanitized
    if (
      this.showMetadata &&
      sanitizedContext &&
      Object.keys(sanitizedContext).length > 0
    ) {
      const metadataStr = this.formatMetadata(sanitizedContext);
      logMessage += ` ${metadataStr}`;
    }

    // Выводим в соответствующий console метод
    switch (level) {
      case LogLevel.TRACE:
      case LogLevel.DEBUG:
      case LogLevel.INFO:
        console.log(logMessage);
        break;
      case LogLevel.WARN:
        console.warn(logMessage);
        break;
      case LogLevel.ERROR:
      case LogLevel.FATAL:
        console.error(logMessage);
        break;
    }
  }

  /**
   * Форматирует metadata для вывода
   *
   * @param context - Контекст
   * @returns Отформатированная строка
   *
   * @remarks
   * Обрабатывает:
   * - Error objects → показывает message и первую строку stack
   * - Objects → JSON.stringify с отступами для больших объектов
   * - Примитивы → toString
   *
   * @internal
   */
  private formatMetadata(context: Record<string, unknown>): string {
    if (!context || Object.keys(context).length === 0) {
      return '';
    }

    // Если есть вложенный error object (от error/fatal методов)
    if (context.error && typeof context.error === 'object') {
      const err = context.error as { message?: string; stack?: string };
      const errorStr = `error: "${err.message}", stack: "${err.stack?.split('\n')[0]}"`;
      const otherContext = { ...context };
      delete otherContext.error;

      if (Object.keys(otherContext).length > 0) {
        // Use safeStringify to prevent exceptions on circular refs
        const otherStr = safeStringify(otherContext);
        return `{ ${errorStr}, ${otherStr.slice(1, -1)} }`;
      }
      return `{ ${errorStr} }`;
    }

    // Обычный контекст - используем safeStringify
    const str = safeStringify(context);
    if (str.length < 100) {
      return str;
    }

    // Для больших объектов делаем pretty print
    return '\n' + safeStringify(context, 2);
  }
}
