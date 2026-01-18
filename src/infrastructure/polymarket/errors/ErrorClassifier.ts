/**
 * ErrorClassifier - Идемпотентный классификатор ошибок с LRU кэшем
 *
 * @remarks
 * Классифицирует ошибки с истинной гарантией идемпотентности:
 * classify(classify(x)) === classify(x) (одна и та же ссылка)
 *
 * Возможности:
 * - LRU кэш: Максимум 1000 записей, старейшие вытесняются первыми
 * - Идемпотентность: Уже классифицированные ошибки возвращаются как есть
 * - Без коллизий: Разные типы с одинаковым сообщением не конфликтуют в кэше
 * - Нулевая утечка памяти: Размер кэша ограничен maxCacheSize
 *
 * Стратегия кэширования:
 * - Кэшируются ТОЛЬКО ошибки типа UNKNOWN
 * - Ключ: сообщение об ошибке
 * - Уже классифицированные ошибки (non-UNKNOWN) обходят кэш
 * - LRU вытеснение: старейшие записи удаляются при заполнении кэша
 *
 * @example
 * ```typescript
 * const classifier = new ErrorClassifier(errorAdapter, logger);
 *
 * const err1 = { type: 'UNKNOWN', message: 'size too small', recoverable: false };
 * const classified = classifier.classify(err1);
 * // classified = { type: 'CONSTRAINT_VIOLATION', violation: { type: 'MIN_SIZE', ... } }
 *
 * const classified2 = classifier.classify(classified);
 * // classified2 === classified (same reference!)
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { ConstraintViolation } from '../../../domain/services/constraints/ConstraintsObservationStore.js';

/**
 * Типы ошибок ордеров
 */
export type OrderErrorType =
  | 'UNKNOWN'
  | 'CONSTRAINT_VIOLATION'
  | 'BALANCE_INSUFFICIENT'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'MARKET_CLOSED'
  | 'ORDER_NOT_FOUND'
  | 'SERVER_ERROR';

/**
 * Базовая ошибка ордера
 */
export interface BaseOrderError {
  type: OrderErrorType;
  message: string;
  recoverable: boolean;
}

/**
 * Ошибка нарушения ограничения
 */
export interface ConstraintViolationError extends BaseOrderError {
  type: 'CONSTRAINT_VIOLATION';
  violation: ConstraintViolation;
}

/**
 * Ошибка ордера (размеченное объединение)
 */
export type OrderError = BaseOrderError | ConstraintViolationError;

/**
 * Структурированная ошибка из парсинга
 */
export interface StructuredError {
  /** Код ошибки (если доступен) */
  code?: string;
  /** Сообщение об ошибке */
  message: string;
  /** Нарушение ограничения (если распознано) */
  violation?: ConstraintViolation;
}

/**
 * Интерфейс ErrorAdapter для парсинга ошибок API
 */
export interface ErrorAdapter {
  /**
   * Распарсить сообщение об ошибке в структурированный формат
   *
   * @param message - Сырое сообщение об ошибке
   * @returns Структурированная ошибка
   */
  parse(message: string): StructuredError;
}

/**
 * ErrorClassifier - Идемпотентная классификация ошибок с LRU кэшем
 *
 * @remarks
 * Гарантии:
 * - Идемпотентность: classify(classify(x)) === classify(x) (равенство ссылок)
 * - Без коллизий: Уже классифицированные ошибки обходят кэш
 * - Нулевая утечка памяти: Размер кэша ≤ maxCacheSize
 * - LRU вытеснение: Старейшие записи удаляются первыми
 *
 * Алгоритм:
 * 1. Если type !== 'UNKNOWN' → вернуть как есть (обход кэша)
 * 2. Проверить кэш по сообщению: если попадание → вернуть кэшированное
 * 3. Если промах: парсить → классифицировать → кэшировать → вернуть
 */
export class ErrorClassifier {
  private readonly cache = new Map<string, OrderError>();
  private readonly maxCacheSize = 1000;

  /**
   * Создать классификатор ошибок
   *
   * @param errorAdapter - Адаптер для парсинга ошибок API
   * @param logger - Экземпляр логгера
   *
   * @example
   * ```typescript
   * const classifier = new ErrorClassifier(errorAdapter, logger);
   * ```
   */
  constructor(
    private readonly errorAdapter: ErrorAdapter,
    private readonly logger: ILogger
  ) {}

  /**
   * Классифицировать ошибку идемпотентно
   *
   * @param error - Сырая или уже классифицированная ошибка
   * @returns Классифицированная ошибка (та же ссылка, если закэширована или уже классифицирована)
   *
   * @remarks
   * Гарантия идемпотентности: classify(classify(x)) === classify(x)
   *
   * Алгоритм:
   * 1. Если ошибка уже классифицирована (type !== 'UNKNOWN') → вернуть как есть
   *    (предотвращает коллизии кэша для разных типов с одинаковым сообщением)
   * 2. Извлечь сообщение и вычислить ключ кэша
   * 3. Проверить кэш: если попадание → переместить в конец (LRU) и вернуть
   * 4. Если промах: распарсить сообщение → классифицировать
   * 5. LRU вытеснение, если кэш полон
   * 6. Закэшировать результат
   * 7. Вернуть результат
   *
   * КРИТИЧЕСКИЕ гарантии:
   * - Уже классифицированные ошибки (non-UNKNOWN) не проходят через кэш
   * - LRU: порядок итерации Map = порядок вставки (ES2015+)
   * - Размер кэша НИКОГДА не превышает maxCacheSize
   *
   * @example
   * ```typescript
   * const err = { type: 'UNKNOWN', message: 'size too small', recoverable: false };
   * const c1 = classifier.classify(err);
   * const c2 = classifier.classify(c1);
   * // c1 === c2 (same reference)
   *
   * // Already classified errors are preserved:
   * const known = { type: 'BALANCE_INSUFFICIENT', message: 'foo', recoverable: true };
   * const c3 = classifier.classify(known);
   * // c3 === known (same reference, no cache collision)
   * ```
   */
  classify(error: OrderError): OrderError {
    // 1. Если ошибка уже классифицирована (не UNKNOWN), вернуть как есть
    // Это предотвращает коллизии кэша: разные типы с одинаковым сообщением
    // не будут перезаписывать друг друга
    if (error.type !== 'UNKNOWN') {
      this.logger.trace('[ErrorClassifier] Already classified, returning as-is', {
        type: error.type,
      });
      return error;
    }

    // 2. Извлечь сообщение и вычислить ключ кэша
    const message = this.extractMessage(error);
    const cacheKey = this.makeCacheKey(message);

    // 3. Проверить кэш (только для UNKNOWN ошибок)
    const cached = this.cache.get(cacheKey);
    if (cached) {
      // КРИТИЧНО: Удалить ПЕРЕД повторным добавлением, чтобы переместить в конец (строгий LRU)
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);

      this.logger.trace('[ErrorClassifier] Cache hit (moved to end)', { cacheKey });
      return cached; // Та же ссылка!
    }

    // 4. Классифицировать (с защитой от исключений парсера)
    let structured: StructuredError;
    try {
      structured = this.errorAdapter.parse(message);
    } catch (parseError) {
      this.logger.error('[ErrorClassifier] errorAdapter.parse threw exception, using fallback', {
        originalMessage: message,
        error: parseError instanceof Error ? parseError.message : String(parseError),
        stack: parseError instanceof Error ? parseError.stack : undefined,
      });
      // Fallback: создаём безопасную структуру, которая даст OrderError с type UNKNOWN
      structured = { message };
    }
    const classified = this.classifyStructured(structured);

    // 5. Использовать результат классификации напрямую (classified уже содержит корректный type и message)
    const result: OrderError = classified;

    // 6. LRU вытеснение ПЕРЕД добавлением (ГАРАНТИРОВАННО первая = старейшая)
    if (this.cache.size >= this.maxCacheSize) {
      // ГАРАНТИРОВАННО: Первая запись старейшая (Map сохраняет порядок вставки)
      const firstKey = this.cache.keys().next().value as string;
      this.cache.delete(firstKey);

      this.logger.trace('[ErrorClassifier] LRU eviction (size limit)', {
        evictedKey: firstKey,
        size: this.cache.size,
      });
    }

    // 7. Закэшировать результат
    this.cache.set(cacheKey, result);

    this.logger.trace('[ErrorClassifier] Cached classification', {
      cacheKey,
      originalType: error.type,
      classifiedType: result.type,
      cacheSize: this.cache.size,
    });

    return result;
  }

  /**
   * Классифицировать структурированную ошибку
   *
   * @param structured - Структурированная ошибка из адаптера
   * @returns Классифицированная OrderError
   *
   * @remarks
   * Правила классификации:
   * - Есть нарушение → CONSTRAINT_VIOLATION
   * - Код содержит "balance" → BALANCE_INSUFFICIENT
   * - Код содержит "network" → NETWORK_ERROR
   * - Код содержит "rate" → RATE_LIMITED
   * - Код содержит "auth" → AUTH_FAILED
   * - Иначе → UNKNOWN
   */
  private classifyStructured(structured: StructuredError): OrderError {
    // Проверить наличие нарушения ограничения
    if (structured.violation) {
      return {
        type: 'CONSTRAINT_VIOLATION',
        message: structured.message,
        recoverable: false,
        violation: structured.violation,
      };
    }

    // Проверить код ошибки
    const code = (structured.code || '').toLowerCase();
    const messageLower = structured.message.toLowerCase();

    if (code.includes('balance') || messageLower.includes('insufficient')) {
      return {
        type: 'BALANCE_INSUFFICIENT',
        message: structured.message,
        recoverable: true,
      };
    }
    // Проверка сетевых ошибок - используем специфичные паттерны,
    // избегая ложных срабатываний на "connection established", "network ready" и т.д.
    if (
      // Коды ошибок (обычно специфичны для сбоев)
      code.includes('network') ||
      code.includes('timeout') ||
      code.includes('econnrefused') ||
      code.includes('econnreset') ||
      code.includes('enotfound') ||
      code.includes('ehostunreach') ||
      // Таймауты
      messageLower.includes('timed out') ||
      messageLower.includes('timeout') ||
      // Специфичные сбои соединения (НЕ общее 'connection')
      messageLower.includes('connection refused') ||
      messageLower.includes('connection reset') ||
      messageLower.includes('connection closed unexpectedly') ||
      messageLower.includes('connection failed') ||
      messageLower.includes('failed to connect') ||
      messageLower.includes('could not connect') ||
      messageLower.includes('cannot connect') ||
      messageLower.includes('unable to connect') ||
      // Сетевые сбои
      messageLower.includes('network error') ||
      messageLower.includes('network failure') ||
      messageLower.includes('network unreachable') ||
      messageLower.includes('no route to host') ||
      messageLower.includes('socket hang up') ||
      messageLower.includes('socket closed')
    ) {
      return {
        type: 'NETWORK_ERROR',
        message: structured.message,
        recoverable: true,
      };
    }

    if (code.includes('rate') || code === '429') {
      return {
        type: 'RATE_LIMITED',
        message: structured.message,
        recoverable: true,
      };
    }

    if (code.includes('auth') || code === '401' || code === '403') {
      return {
        type: 'AUTH_FAILED',
        message: structured.message,
        recoverable: false,
      };
    }

    if (code.includes('closed') || messageLower.includes('market closed')) {
      return {
        type: 'MARKET_CLOSED',
        message: structured.message,
        recoverable: false,
      };
    }

    if (code === '404' || messageLower.includes('not found')) {
      return {
        type: 'ORDER_NOT_FOUND',
        message: structured.message,
        recoverable: false,
      };
    }

    if (/^5\d{2}$/.test(code) || messageLower.includes('server error')) {
      return {
        type: 'SERVER_ERROR',
        message: structured.message,
        recoverable: true,
      };
    }

    // Неизвестная
    return {
      type: 'UNKNOWN',
      message: structured.message,
      recoverable: false,
    };
  }

  /**
   * Извлечь сообщение из ошибки
   *
   * @param error - Ошибка ордера
   * @returns Строка сообщения
   *
   * @remarks
   * Проверяем наличие поля, а не его truthy-значение.
   * Пустая строка '' - валидное сообщение и должна быть возвращена.
   */
  private extractMessage(error: OrderError): string {
    // Проверяем наличие поля message (не truthy, чтобы пустая строка была валидной)
    if ('message' in error && error.message !== undefined && error.message !== null) {
      return error.message;
    }
    // Fallback на violation если message отсутствует
    if ('violation' in error && error.violation !== undefined && error.violation !== null) {
      return JSON.stringify(error.violation);
    }
    return 'Unknown error';
  }

  /**
   * Создать ключ кэша из сообщения
   *
   * @param message - Сообщение об ошибке
   * @returns Ключ кэша
   *
   * @remarks
   * Ключ = только сообщение (без type для истинной идемпотентности).
   * Это гарантирует: classify(classify(x)) === classify(x),
   * т.к. одинаковые сообщения всегда дают один и тот же кэшированный результат,
   * независимо от того, был ли type UNKNOWN или уже классифицирован.
   */
  private makeCacheKey(message: string): string {
    return message;
  }

  /**
   * Очистить кэш (для тестирования)
   *
   * @remarks
   * Не должно использоваться в продакшене.
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.warn('[ErrorClassifier] Cache cleared');
  }

  /**
   * Получить размер кэша (для мониторинга)
   *
   * @returns Текущий размер кэша
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}
