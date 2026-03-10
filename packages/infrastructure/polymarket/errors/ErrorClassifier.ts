/**
 * ErrorClassifier — идемпотентный классификатор ошибок с LRU-кэшем.
 *
 * @remarks
 * Классифицирует ошибки с гарантией истинной идемпотентности:
 * classify(classify(x)) === classify(x) (та же ссылка)
 *
 * Особенности:
 * - LRU-кэш: максимум 1000 записей, старейшие вытесняются первыми
 * - Идемпотентность: одинаковые (тип + сообщение) → одинаковый кэшированный результат
 * - Ссылочное равенство: двойной вызов classify(x) возвращает ОДИН объект
 * - Нет утечек памяти: размер кэша ограничен maxCacheSize
 *
 * Стратегия кэширования:
 * - Ключ: тип + первые 100 символов сообщения
 * - Значение: классифицированная OrderError
 * - LRU вытеснение: старейшие записи удаляются при переполнении
 * - Двойное кэширование при смене типа: оба ключа (входной и результата) всегда ссылаются
 *   на ОДИН и тот же канонический объект и обновляются вместе при cache hit и cache miss —
 *   гарантирует classify(classify(x)) === classify(x) (ссылочное равенство)
 * - Без TTL: кэш живёт на протяжении сессии
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

import type { ILogger } from '@polymarket/logger';
import type { ConstraintViolation } from '../stubs/domain/services/constraints/ConstraintsObservationStore.js';

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
 * Ошибка ордера (дискриминированный union)
 */
export type OrderError = BaseOrderError | ConstraintViolationError;

/**
 * Структурированная ошибка из парсинга
 */
export interface StructuredError {
  /** Код ошибки (если доступен) */
  code?: string;
  /** Сообщение ошибки */
  message: string;
  /** Нарушение ограничения (если распарсено) */
  violation?: ConstraintViolation;
}

/**
 * Интерфейс ErrorAdapter для разбора ошибок API
 */
export interface ErrorAdapter {
  /**
   * Разбирает сообщение об ошибке в структурированный формат.
   *
   * @param message - Необработанное сообщение об ошибке
   * @returns Структурированная ошибка
   */
  parse(message: string): StructuredError;
}

/**
 * ErrorClassifier — идемпотентная классификация ошибок с LRU-кэшем.
 *
 * @remarks
 * Гарантии:
 * - Идемпотентность: classify(classify(x)) === classify(x) (ссылочное равенство)
 * - Нет утечек памяти: размер кэша ≤ maxCacheSize
 * - LRU-вытеснение: старейшие записи удаляются первыми
 *
 * Алгоритм:
 * 1. Вычисляем ключ кэша по (тип + сообщение)
 * 2. Проверяем кэш: попадание → возвращаем кэшированный (та же ссылка)
 * 3. Промах: разбираем → классифицируем → кэшируем → возвращаем
 * 4. Перед кэшированием: если size >= maxSize → удаляем старейший
 */
export class ErrorClassifier {
  private readonly cache = new Map<string, OrderError>();
  private readonly maxCacheSize = 1000;

  /**
   * Создаёт классификатор ошибок.
   *
   * @param errorAdapter - Адаптер для разбора ошибок API
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
   * Идемпотентно классифицирует ошибку.
   *
   * @param error - Необработанная или уже классифицированная ошибка
   * @returns Классифицированная ошибка (та же ссылка при попадании в кэш)
   *
   * @remarks
   * Гарантия идемпотентности: classify(classify(x)) === classify(x)
   *
   * Алгоритм:
   * 1. Вычисляем ключ кэша по (тип + сообщение)
   * 2. Проверяем кэш: попадание → удаляем + добавляем заново для перемещения в конец (строгий LRU)
   * 3. Промах:
   *    a. Извлекаем сообщение из ошибки
   *    b. Разбираем сообщение → StructuredError (ErrorAdapter)
   *    c. Классифицируем StructuredError → OrderError
   *    d. Выбираем лучшую классификацию (новая vs существующая)
   *    e. LRU-вытеснение при заполненном кэше (ГАРАНТИЯ: первая запись = старейшая)
   *    f. Кэшируем результат
   * 4. Возвращаем результат
   *
   * КРИТИЧНЫЕ гарантии LRU:
   * - Порядок итерации Map = порядок вставки (спецификация ES2015+)
   * - Самые свежие ошибки — в КОНЦЕ Map
   * - Старейшие ошибки — в НАЧАЛЕ Map
   * - Размер кэша НИКОГДА не превышает maxCacheSize
   * - Вытеснение ВСЕГДА применяется к старейшей записи (Map.keys().next().value)
   *
   * Безопасность при высокой нагрузке:
   * - Однопоточный JS: гонок нет
   * - Атомарный delete+set: перемещение в конец безопасно
   *
   * @example
   * ```typescript
   * const err = { type: 'UNKNOWN', message: 'size too small', recoverable: false };
   * const c1 = classifier.classify(err);
   * const c2 = classifier.classify(c1);
   * // c1 === c2 (same reference)
   * ```
   */
  classify(error: OrderError): OrderError {
    // 1. Вычисляем ключ кэша
    const cacheKey = this.makeCacheKey(error);

    // 2. Проверяем кэш
    const cached = this.cache.get(cacheKey);
    if (cached) {
      // КРИТИЧНО: Удаляем ПЕРЕД повторным добавлением для перемещения в конец (строгий LRU)
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);

      // Обновляем alias resultKey (если есть) — оба ключа должны стареть вместе.
      // Без этого alias evict-ится раньше, что приводит к созданию дубликата объекта при следующем промахе.
      const resultKey = this.makeCacheKey(cached);
      if (resultKey !== cacheKey && this.cache.has(resultKey)) {
        this.cache.delete(resultKey);
        this.cache.set(resultKey, cached);
      }

      this.logger.trace('[ErrorClassifier] Cache hit (moved to end)', { cacheKey });
      return cached; // Та же ссылка!
    }

    // 3. Классифицируем
    const message = this.extractMessage(error);
    const structured = this.errorAdapter.parse(message);
    const classified = this.classifyStructured(structured);

    // 4. Выбираем лучшую классификацию
    let result: OrderError;
    if (classified.type !== 'UNKNOWN') {
      // Новая классификация лучше
      result = classified;
    } else if (error.type !== 'UNKNOWN') {
      // Сохраняем оригинал если уже классифицирован
      result = error;
    } else {
      // Оба неизвестны — используем новый
      result = { type: 'UNKNOWN', message, recoverable: false };
    }

    const resultKey = this.makeCacheKey(result);

    // Если resultKey уже существует в кэше — переиспользуем тот же канонический объект.
    // Это предотвращает создание дублирующих экземпляров для одной и той же классификации.
    if (resultKey !== cacheKey) {
      const existingCanonical = this.cache.get(resultKey);
      if (existingCanonical) {
        result = existingCanonical;
      }
    }

    // 5. LRU вытеснение ПЕРЕД добавлением cacheKey (ГАРАНТИЯ: первый = старейший)
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value as string;
      this.cache.delete(firstKey);

      this.logger.trace('[ErrorClassifier] LRU eviction (size limit)', {
        evictedKey: firstKey,
        size: this.cache.size,
      });
    }

    // 6. Кэшируем под cacheKey
    this.cache.set(cacheKey, result);

    // 7. Кэшируем/освежаем alias resultKey (если ключи разные).
    //    delete+set перемещает запись в конец Map (LRU refresh) независимо от того,
    //    существовала ли она раньше. Вытеснение только если запись новая.
    if (resultKey !== cacheKey) {
      const resultKeyIsNew = !this.cache.has(resultKey);
      if (resultKeyIsNew && this.cache.size >= this.maxCacheSize) {
        const firstKey = this.cache.keys().next().value as string;
        this.cache.delete(firstKey);
      }
      this.cache.delete(resultKey);
      this.cache.set(resultKey, result);
    }

    this.logger.trace('[ErrorClassifier] Cached classification', {
      cacheKey,
      resultKey,
      originalType: error.type,
      classifiedType: result.type,
      cacheSize: this.cache.size,
    });

    return result;
  }

  /**
   * Классифицирует структурированную ошибку.
   *
   * @param structured - Структурированная ошибка из адаптера
   * @returns Классифицированная OrderError
   *
   * @remarks
   * Правила классификации:
   * - Есть violation → CONSTRAINT_VIOLATION
   * - Код содержит "balance" → BALANCE_INSUFFICIENT
   * - Код содержит "network" → NETWORK_ERROR
   * - Код содержит "rate" → RATE_LIMITED
   * - Код содержит "auth" → AUTH_FAILED
   * - Код соответствует /5\d{2}/ (HTTP 5xx) → SERVER_ERROR
   * - Иначе → UNKNOWN
   */
  private classifyStructured(structured: StructuredError): OrderError {
    // Проверяем нарушение ограничения
    if (structured.violation) {
      return {
        type: 'CONSTRAINT_VIOLATION',
        message: structured.message,
        recoverable: false,
        violation: structured.violation,
      };
    }

    // Проверяем код ошибки
    const code = (structured.code || '').toLowerCase();

    if (code.includes('balance') || structured.message.toLowerCase().includes('insufficient')) {
      return {
        type: 'BALANCE_INSUFFICIENT',
        message: structured.message,
        recoverable: true,
      };
    }

    if (code.includes('network') || code.includes('timeout') || code.includes('econnrefused')) {
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

    // Проверяем только точные трёхзначные HTTP 5xx коды (500–599), чтобы не ловить подстроки вроде "E1500"
    const codeNum = parseInt(code, 10);
    const is5xx = code.length === 3 && codeNum >= 500 && codeNum <= 599;
    if (is5xx || structured.message.toLowerCase().includes('server error')) {
      return {
        type: 'SERVER_ERROR',
        message: structured.message,
        recoverable: true,
      };
    }

    // Неизвестная ошибка
    return {
      type: 'UNKNOWN',
      message: structured.message,
      recoverable: false,
    };
  }

  /**
   * Извлекает сообщение из ошибки.
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
    return 'Unknown error';
  }

  /**
   * Формирует ключ кэша из ошибки.
   *
   * @param error - Ошибка ордера
   * @returns Ключ кэша
   *
   * @remarks
   * Ключ = тип + первые 100 символов сообщения.
   * Включаем type чтобы два разных типа с одинаковым сообщением не коллидировали в кэше.
   *
   * Идемпотентность (classify(classify(x)) === classify(x)) обеспечивается в classify():
   * при смене типа (UNKNOWN → CONSTRAINT_VIOLATION) результат кэшируется дополнительно
   * под ключом результата, поэтому повторный вызов с уже классифицированной ошибкой
   * гарантированно попадает в кэш и возвращает тот же объект.
   */
  private makeCacheKey(error: OrderError): string {
    const message = this.extractMessage(error);
    return `${error.type}:${message.substring(0, 100)}`;
  }

  /**
   * Очищает кэш (для тестирования).
   *
   * @remarks
   * Не должно использоваться в production.
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.warn('[ErrorClassifier] Cache cleared');
  }

  /**
   * Возвращает размер кэша (для мониторинга).
   *
   * @returns Текущий размер кэша
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}
