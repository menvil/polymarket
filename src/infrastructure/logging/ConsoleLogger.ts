/**
 * Console Logger - реализация ILogger
 *
 * @remarks
 * Простая реализация логгера для вывода в консоль.
 * Поддерживает:
 * - 6 уровней логирования (silly, trace, debug, info, warn, error)
 * - Цветной вывод для разных уровней
 * - Timestamps
 * - Структурированные метаданные
 * - Child loggers с контекстом
 *
 * Уровни логирования (от самого детального к критичному):
 * - silly: Максимальная детализация (внутренние детали реализации)
 * - trace: Трассировка выполнения (вход/выход из функций)
 * - debug: Отладочная информация
 * - info: Информационные сообщения
 * - warn: Предупреждения
 * - error: Ошибки
 *
 * Алгоритм:
 * 1. Форматирует сообщение с timestamp и уровнем
 * 2. Добавляет контекст если это child logger
 * 3. Применяет цветовое кодирование
 * 4. Выводит в console.log/warn/error
 * 5. Добавляет metadata если присутствуют
 *
 * Формат вывода:
 * [2024-01-15T10:30:45.123Z] [INFO] [Context] Message { metadata }
 *
 * @example
 * ```typescript
 * const logger = new ConsoleLogger({ level: 'debug', colors: true });
 *
 * logger.silly('Parsing level', { price: '0.52', size: '100' });
 * logger.trace('Entering handleMessage');
 * logger.debug('Fetching orderbook', { marketId: '0xabc' });
 * logger.info('Trading bot started');
 * logger.warn('High position detected', { netPosition: 500 });
 * logger.error('Failed to place order', { error: new Error('Network error') });
 *
 * // Child logger с контекстом
 * const mmLogger = logger.child('MarketMaker');
 * mmLogger.info('Quote sent'); // Вывод: [INFO] [MarketMaker] Quote sent
 * ```
 */

import { ILogger } from '../../domain/ports/ILogger.js';

/**
 * Уровень логирования
 *
 * @remarks
 * Уровни от самого детального к самому критичному:
 * - silly: Максимально детальная информация (внутренние детали)
 * - trace: Трассировка выполнения (вход/выход функций)
 * - debug: Отладочная информация
 * - info: Информационные сообщения
 * - warn: Предупреждения
 * - error: Ошибки
 */
export type LogLevel = 'silly' | 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * Конфигурация ConsoleLogger
 */
export interface ConsoleLoggerConfig {
  /** Минимальный уровень для вывода (по умолчанию 'info') */
  level?: LogLevel;
  /** Использовать цветовое кодирование (по умолчанию true) */
  colors?: boolean;
  /** Показывать timestamp (по умолчанию true) */
  timestamp?: boolean;
  /** Показывать metadata (по умолчанию true) */
  showMetadata?: boolean;
}

/**
 * ANSI color codes для консоли
 */
const COLORS = {
  reset: '\x1b[0m',
  silly: '\x1b[90m', // Gray (самый тихий цвет для максимальной детализации)
  trace: '\x1b[94m', // Light Blue
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m', // Green
  warn: '\x1b[33m', // Yellow
  error: '\x1b[31m', // Red
  timestamp: '\x1b[90m', // Gray
  context: '\x1b[35m', // Magenta
} as const;

/**
 * Уровни логирования (для фильтрации)
 *
 * @remarks
 * Числа определяют приоритет: меньше = более детальный уровень.
 * Если level = 'debug', то будут выводиться debug, info, warn, error.
 * Если level = 'silly', то будут выводиться все уровни.
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  silly: 0,
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
};

/**
 * Console Logger
 *
 * @remarks
 * Реализация ILogger для вывода в консоль с форматированием.
 */
export class ConsoleLogger implements ILogger {
  private readonly level: LogLevel;
  private readonly useColors: boolean;
  private readonly showTimestamp: boolean;
  private readonly showMetadata: boolean;
  private readonly context?: string;

  /**
   * Создаёт новый Console Logger
   *
   * @param config - Конфигурация логгера
   * @param context - Контекст для child logger (внутренний параметр)
   */
  constructor(config: ConsoleLoggerConfig = {}, context?: string) {
    this.level = config.level ?? 'info';
    this.useColors = config.colors ?? true;
    this.showTimestamp = config.timestamp ?? true;
    this.showMetadata = config.showMetadata ?? true;
    this.context = context;
  }

  /**
   * Логирует самое детальное сообщение (уровень SILLY)
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные
   *
   * @remarks
   * Уровень SILLY: максимально детальная информация для глубокой отладки.
   *
   * @example
   * ```typescript
   * logger.silly('Parsing orderbook level', {
   *   price: '0.52',
   *   size: '100',
   *   index: 0
   * });
   * ```
   */
  public silly(message: string, metadata?: any): void {
    this.log('silly', message, metadata);
  }

  /**
   * Логирует трассировочное сообщение (уровень TRACE)
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные
   *
   * @remarks
   * Уровень TRACE: трассировка выполнения программы.
   *
   * @example
   * ```typescript
   * logger.trace('Entering handleOrderbookUpdate', {
   *   tokenId: '0xabc...',
   *   bidsCount: 10
   * });
   * ```
   */
  public trace(message: string, metadata?: any): void {
    this.log('trace', message, metadata);
  }

  /**
   * Логирует отладочное сообщение
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные
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
  public debug(message: string, metadata?: any): void {
    this.log('debug', message, metadata);
  }

  /**
   * Логирует информационное сообщение
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные
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
  public info(message: string, metadata?: any): void {
    this.log('info', message, metadata);
  }

  /**
   * Логирует предупреждение
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные
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
  public warn(message: string, metadata?: any): void {
    this.log('warn', message, metadata);
  }

  /**
   * Логирует ошибку
   *
   * @param message - Текст сообщения
   * @param metadata - Дополнительные данные (обычно Error object)
   *
   * @remarks
   * Уровень ERROR: критические ошибки.
   *
   * @example
   * ```typescript
   * logger.error('Failed to cancel order', {
   *   orderId: '0x123',
   *   error: err,
   *   stack: err.stack
   * });
   * ```
   */
  public error(message: string, metadata?: any): void {
    this.log('error', message, metadata);
  }

  /**
   * Создаёт дочерний логгер с контекстом
   *
   * @param context - Контекст (например, имя сервиса/модуля)
   * @returns Новый логгер с добавленным контекстом
   *
   * @remarks
   * Дочерний логгер наследует конфигурацию родителя.
   * Все сообщения будут включать указанный контекст.
   *
   * @example
   * ```typescript
   * const logger = new ConsoleLogger();
   * const mmLogger = logger.child('MarketMaker');
   * const riskLogger = logger.child('RiskManager');
   *
   * mmLogger.info('Started'); // [INFO] [MarketMaker] Started
   * riskLogger.warn('Limit exceeded'); // [WARN] [RiskManager] Limit exceeded
   * ```
   */
  public child(context: string): ILogger {
    const fullContext = this.context ? `${this.context}:${context}` : context;
    return new ConsoleLogger(
      {
        level: this.level,
        colors: this.useColors,
        timestamp: this.showTimestamp,
        showMetadata: this.showMetadata,
      },
      fullContext
    );
  }

  /**
   * Основной метод логирования
   *
   * @param level - Уровень лога
   * @param message - Сообщение
   * @param metadata - Метаданные
   *
   * @remarks
   * Алгоритм:
   * 1. Проверяет минимальный уровень (фильтрация)
   * 2. Форматирует timestamp
   * 3. Форматирует level с цветами
   * 4. Добавляет контекст если есть
   * 5. Форматирует metadata
   * 6. Выводит в соответствующий console метод
   */
  private log(level: LogLevel, message: string, metadata?: any): void {
    // Фильтруем по минимальному уровню
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) {
      return;
    }

    // Форматируем сообщение
    const parts: string[] = [];

    // Timestamp
    if (this.showTimestamp) {
      const timestamp = new Date().toISOString();
      if (this.useColors) {
        parts.push(`${COLORS.timestamp}[${timestamp}]${COLORS.reset}`);
      } else {
        parts.push(`[${timestamp}]`);
      }
    }

    // Level (no padding - cleaner output)
    const levelStr = level.toUpperCase();
    if (this.useColors) {
      const color = COLORS[level];
      parts.push(`${color}[${levelStr}]${COLORS.reset}`);
    } else {
      parts.push(`[${levelStr}]`);
    }

    // Context
    if (this.context) {
      if (this.useColors) {
        parts.push(`${COLORS.context}[${this.context}]${COLORS.reset}`);
      } else {
        parts.push(`[${this.context}]`);
      }
    }

    // Message
    parts.push(message);

    // Формируем итоговую строку
    let logMessage = parts.join(' ');

    // Metadata
    if (this.showMetadata && metadata !== undefined) {
      const metadataStr = this.formatMetadata(metadata);
      logMessage += ` ${metadataStr}`;
    }

    // Выводим в соответствующий console метод
    switch (level) {
      case 'silly':
      case 'trace':
      case 'debug':
      case 'info':
        console.log(logMessage);
        break;
      case 'warn':
        console.warn(logMessage);
        break;
      case 'error':
        console.error(logMessage);
        break;
    }
  }

  /**
   * Форматирует metadata для вывода
   *
   * @param metadata - Метаданные
   * @returns Отформатированная строка
   *
   * @remarks
   * Обрабатывает:
   * - Error objects → показывает message и stack
   * - Objects → JSON.stringify с отступами
   * - Примитивы → toString
   */
  private formatMetadata(metadata: any): string {
    if (metadata === null || metadata === undefined) {
      return '';
    }

    // Если это Error объект
    if (metadata instanceof Error) {
      return `{ error: "${metadata.message}", stack: "${metadata.stack?.split('\n')[0]}" }`;
    }

    // Если это объект
    if (typeof metadata === 'object') {
      try {
        // Для небольших объектов показываем inline
        const str = JSON.stringify(metadata);
        if (str.length < 100) {
          return str;
        }

        // Для больших объектов делаем pretty print
        return '\n' + JSON.stringify(metadata, null, 2);
      } catch (error) {
        return '[Circular or non-serializable object]';
      }
    }

    // Примитивы
    return String(metadata);
  }

  /**
   * Устанавливает минимальный уровень логирования
   *
   * @param level - Новый уровень
   *
   * @remarks
   * Изменяет уровень для данного логгера.
   * Child loggers не затрагиваются.
   *
   * @example
   * ```typescript
   * logger.setLevel('debug'); // Теперь логируются debug сообщения
   * ```
   */
  public setLevel(level: LogLevel): void {
    // Note: Так как поля readonly, создаём новый объект через приватный доступ
    // В реальной реализации можно сделать level изменяемым
    (this as any).level = level;
  }

  /**
   * Возвращает текущий уровень логирования
   *
   * @returns Текущий уровень
   */
  public getLevel(): LogLevel {
    return this.level;
  }
}
