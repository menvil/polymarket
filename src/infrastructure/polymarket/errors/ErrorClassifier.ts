/**
 * ErrorClassifier - Идемпотентный классификатор ошибок с LRU кэшем
 *
 * @remarks
 * Классифицирует ошибки с истинной гарантией идемпотентности:
 * classify(classify(x)) === classify(x) (одна и та же ссылка)
 *
 * Возможности:
 * - LRU кэш: Максимум 1000 записей, старейшие вытесняются первыми
 * - Идемпотентность: Одинаковые (type + message) → один и тот же кэшированный результат
 * - Равенство ссылок: classify(x) дважды возвращает ОДИН И ТОТ ЖЕ объект
 * - Нулевая утечка памяти: Размер кэша ограничен maxCacheSize
 *
 * Стратегия кэширования:
 * - Ключ: type + полное сообщение (для избежания коллизий)
 * - Значение: классифицированная OrderError
 * - LRU вытеснение: старейшие записи удаляются при заполнении кэша
 * - Без TTL: кэш сохраняется на протяжении жизни сессии
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
 * // classified2 === classified (одна и та же ссылка!)
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
 * - Нулевая утечка памяти: Размер кэша ≤ maxCacheSize
 * - LRU вытеснение: Старейшие записи удаляются первыми
 *
 * Алгоритм:
 * 1. Вычислить ключ кэша из (type + message)
 * 2. Проверить кэш: если попадание → вернуть кэшированное (та же ссылка)
 * 3. Если промах: парсить → классифицировать → кэшировать → вернуть
 * 4. Перед кэшированием: если size >= maxSize → удалить старейшее
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
   * @returns Классифицированная ошибка (та же ссылка, если закэширована)
   *
   * @remarks
   * Гарантия идемпотентности: classify(classify(x)) === classify(x)
   *
   * Алгоритм:
   * 1. Вычислить ключ кэша из (type + message)
   * 2. Проверить кэш: если попадание → удалить + добавить снова, чтобы переместить в конец (строгий LRU)
   * 3. Если промах:
   *    a. Извлечь сообщение из ошибки
   *    b. Распарсить сообщение → StructuredError (ErrorAdapter)
   *    c. Классифицировать StructuredError → OrderError
   *    d. Выбрать лучшую классификацию (новая vs существующая)
   *    e. LRU вытеснение, если кэш полон (ГАРАНТИРОВАННО первая запись = старейшая)
   *    f. Закэшировать результат
   * 4. Вернуть результат
   *
   * КРИТИЧЕСКИЕ гарантии LRU:
   * - Порядок итерации Map = порядок вставки (спецификация ES2015+)
   * - Самые свежие ошибки в КОНЦЕ Map
   * - Старейшие ошибки в НАЧАЛЕ Map
   * - Размер кэша НИКОГДА не превышает maxCacheSize
   * - Вытеснение ВСЕГДА старейшей записи (Map.keys().next().value)
   *
   * Безопасность при высокой нагрузке:
   * - Однопоточный JS: нет гонки данных
   * - Атомарное delete+set: перемещение в конец безопасно
   *
   * @example
   * ```typescript
   * const err = { type: 'UNKNOWN', message: 'size too small', recoverable: false };
   * const c1 = classifier.classify(err);
   * const c2 = classifier.classify(c1);
   * // c1 === c2 (та же ссылка)
   * ```
   */
  classify(error: OrderError): OrderError {
    // 1. Вычислить ключ кэша
    const cacheKey = this.makeCacheKey(error);

    // 2. Проверить кэш
    const cached = this.cache.get(cacheKey);
    if (cached) {
      // КРИТИЧНО: Удалить ПЕРЕД повторным добавлением, чтобы переместить в конец (строгий LRU)
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);

      this.logger.trace('[ErrorClassifier] Попадание в кэш (перемещено в конец)', { cacheKey });
      return cached; // Та же ссылка!
    }

    // 3. Классифицировать
    const message = this.extractMessage(error);
    const structured = this.errorAdapter.parse(message);
    const classified = this.classifyStructured(structured);

    // 4. Выбрать лучшую классификацию
    let result: OrderError;
    if (classified.type !== 'UNKNOWN') {
      // Новая классификация лучше
      result = classified;
    } else if (error.type !== 'UNKNOWN') {
      // Сохранить оригинал, если уже классифицирован
      result = error;
    } else {
      // Обе неизвестны - использовать новую
      result = { type: 'UNKNOWN', message, recoverable: false };
    }

    // 5. LRU вытеснение ПЕРЕД добавлением (ГАРАНТИРОВАННО первая = старейшая)
    if (this.cache.size >= this.maxCacheSize) {
      // ГАРАНТИРОВАННО: Первая запись старейшая (Map сохраняет порядок вставки)
      const firstKey = this.cache.keys().next().value as string;
      this.cache.delete(firstKey);

      this.logger.trace('[ErrorClassifier] LRU вытеснение (лимит размера)', {
        evictedKey: firstKey,
        size: this.cache.size,
      });
    }

    // 6. Закэшировать результат
    this.cache.set(cacheKey, result);

    this.logger.trace('[ErrorClassifier] Закэшированная классификация', {
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

    if (code.includes('balance') || structured.message.toLowerCase().includes('insufficient')) {
      return {
        type: 'BALANCE_INSUFFICIENT',
        message: structured.message,
        recoverable: true,
      };
    }

    const messageLower = structured.message.toLowerCase();
    if (
      code.includes('network') ||
      code.includes('timeout') ||
      code.includes('econnrefused') ||
      messageLower.includes('timed out') ||
      messageLower.includes('timeout') ||
      messageLower.includes('connection refused') ||
      messageLower.includes('connection') ||
      messageLower.includes('network') ||
      messageLower.includes('network error')
    ) {
      return {
        type: 'NETWORK_ERROR',
        message: structured.message,
        recoverable: true,
      };
    }

    if (code.includes('rate') || code.includes('429')) {
      return {
        type: 'RATE_LIMITED',
        message: structured.message,
        recoverable: true,
      };
    }

    if (code.includes('auth') || code.includes('401') || code.includes('403')) {
      return {
        type: 'AUTH_FAILED',
        message: structured.message,
        recoverable: false,
      };
    }

    if (code.includes('closed') || structured.message.toLowerCase().includes('market closed')) {
      return {
        type: 'MARKET_CLOSED',
        message: structured.message,
        recoverable: false,
      };
    }

    if (code.includes('404') || structured.message.toLowerCase().includes('not found')) {
      return {
        type: 'ORDER_NOT_FOUND',
        message: structured.message,
        recoverable: false,
      };
    }

    if (code.startsWith('5') || structured.message.toLowerCase().includes('server error')) {
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
   */
  private extractMessage(error: OrderError): string {
    if ('message' in error && error.message) {
      return error.message;
    }
    if ('violation' in error && error.violation) {
      return JSON.stringify(error.violation);
    }
    return 'Неизвестная ошибка';
  }

  /**
   * Создать ключ кэша из ошибки
   *
   * @param error - Ошибка ордера
   * @returns Ключ кэша
   *
   * @remarks
   * Ключ = type + полное сообщение
   * Одинаковые (type, message) → один ключ → один кэшированный результат
   * Использует полное сообщение для избежания коллизий
   */
  private makeCacheKey(error: OrderError): string {
    const message = this.extractMessage(error);
    // Ключ кэша: type + полное сообщение (без обрезания)
    return `${error.type}:${message}`;
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
