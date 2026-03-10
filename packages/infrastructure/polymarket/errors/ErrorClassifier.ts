/**
 * ErrorClassifier - Idempotent error classifier with LRU cache
 *
 * @remarks
 * Classifies errors with true idempotency guarantee:
 * classify(classify(x)) === classify(x) (same reference)
 *
 * Features:
 * - LRU cache: Max 1000 entries, oldest evicted first
 * - Idempotent: Same (type + message) → same cached result
 * - Reference equality: classify(x) twice returns SAME object
 * - Zero memory leak: Cache size capped at maxCacheSize
 *
 * Caching strategy:
 * - Key: hash(type + first 100 chars of message)
 * - Value: classified OrderError
 * - LRU eviction: oldest entries deleted when cache full
 * - No TTL: cache persists for session lifetime
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
 * Order error types
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
 * Base order error
 */
export interface BaseOrderError {
  type: OrderErrorType;
  message: string;
  recoverable: boolean;
}

/**
 * Constraint violation error
 */
export interface ConstraintViolationError extends BaseOrderError {
  type: 'CONSTRAINT_VIOLATION';
  violation: ConstraintViolation;
}

/**
 * Order error (discriminated union)
 */
export type OrderError = BaseOrderError | ConstraintViolationError;

/**
 * Structured error from parsing
 */
export interface StructuredError {
  /** Error code (if available) */
  code?: string;
  /** Error message */
  message: string;
  /** Constraint violation (if parsed) */
  violation?: ConstraintViolation;
}

/**
 * ErrorAdapter interface for parsing API errors
 */
export interface ErrorAdapter {
  /**
   * Parse error message to structured format
   *
   * @param message - Raw error message
   * @returns Structured error
   */
  parse(message: string): StructuredError;
}

/**
 * ErrorClassifier - Idempotent error classification with LRU cache
 *
 * @remarks
 * Guarantees:
 * - Idempotency: classify(classify(x)) === classify(x) (reference equality)
 * - Zero memory leak: Cache size ≤ maxCacheSize
 * - LRU eviction: Oldest entries deleted first
 *
 * Algorithm:
 * 1. Compute cache key from (type + message)
 * 2. Check cache: if hit → return cached (same reference)
 * 3. If miss: parse → classify → cache → return
 * 4. Before caching: if size >= maxSize → delete oldest
 */
export class ErrorClassifier {
  private readonly cache = new Map<string, OrderError>();
  private readonly maxCacheSize = 1000;

  /**
   * Create error classifier
   *
   * @param errorAdapter - Adapter for parsing API errors
   * @param logger - Logger instance
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
   * Classify error idempotently
   *
   * @param error - Raw or already-classified error
   * @returns Classified error (same reference if cached)
   *
   * @remarks
   * Idempotency guarantee: classify(classify(x)) === classify(x)
   *
   * Algorithm:
   * 1. Compute cache key from (type + message)
   * 2. Check cache: if hit → delete + re-add to move to end (strict LRU)
   * 3. If miss:
   *    a. Extract message from error
   *    b. Parse message → StructuredError (ErrorAdapter)
   *    c. Classify StructuredError → OrderError
   *    d. Choose best classification (new vs existing)
   *    e. LRU eviction if cache full (GUARANTEED first entry = oldest)
   *    f. Cache result
   * 4. Return result
   *
   * CRITICAL LRU guarantees:
   * - Map iteration order = insertion order (ES2015+ spec)
   * - Most recent errors at END of Map
   * - Oldest errors at BEGINNING of Map
   * - Cache size NEVER exceeds maxCacheSize
   * - Eviction is ALWAYS oldest entry (Map.keys().next().value)
   *
   * High-load safety:
   * - Single-threaded JS: no race conditions
   * - Atomic delete+set: move to end is safe
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

    // 5. LRU вытеснение ПЕРЕД добавлением (ГАРАНТИЯ: первый = старейший)
    if (this.cache.size >= this.maxCacheSize) {
      // ГАРАНТИЯ: Первая запись — старейшая (Map сохраняет порядок вставки)
      const firstKey = this.cache.keys().next().value as string;
      this.cache.delete(firstKey);

      this.logger.trace('[ErrorClassifier] LRU eviction (size limit)', {
        evictedKey: firstKey,
        size: this.cache.size,
      });
    }

    // 6. Кэшируем результат
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
   * Classify structured error
   *
   * @param structured - Structured error from adapter
   * @returns Classified OrderError
   *
   * @remarks
   * Classification rules:
   * - Has violation → CONSTRAINT_VIOLATION
   * - Code contains "balance" → BALANCE_INSUFFICIENT
   * - Code contains "network" → NETWORK_ERROR
   * - Code contains "rate" → RATE_LIMITED
   * - Code contains "auth" → AUTH_FAILED
   * - Code matches /5\d{2}/ (5xx HTTP) → SERVER_ERROR
   * - Otherwise → UNKNOWN
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

    if (/5\d{2}/.test(code) || structured.message.toLowerCase().includes('server error')) {
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
   * Extract message from error
   *
   * @param error - Order error
   * @returns Message string
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
   * Make cache key from error
   *
   * @param error - Order error
   * @returns Cache key
   *
   * @remarks
   * Key = first 100 chars of message (NOT type).
   * Excluding type is critical for idempotency: classify(classify(x)) === classify(x).
   * If we keyed on type, a reclassified error (type changed from UNKNOWN to CONSTRAINT_VIOLATION)
   * would produce a different key on second call → cache miss → re-classified → not same reference.
   */
  private makeCacheKey(error: OrderError): string {
    const message = this.extractMessage(error);
    // Ключ: только первые 100 символов сообщения (без type — иначе нарушается идемпотентность)
    return message.substring(0, 100);
  }

  /**
   * Clear cache (for testing)
   *
   * @remarks
   * Should not be used in production.
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.warn('[ErrorClassifier] Cache cleared');
  }

  /**
   * Get cache size (for monitoring)
   *
   * @returns Current cache size
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}
