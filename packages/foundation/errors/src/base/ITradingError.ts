/**
 * ITradingError - интерфейс для всех ошибок в trading системе
 *
 * @remarks
 * Все ошибки в системе должны реализовать этот интерфейс.
 * Предоставляет структурированную обработку ошибок с severity и контекстом.
 *
 * @example
 * ```typescript
 * import { ITradingError, ErrorSeverity } from '@polymarket/errors';
 *
 * export class ValidationError extends Error implements ITradingError {
 *   public readonly severity: ErrorSeverity = 'low';
 *   public readonly timestamp: Date;
 *   public readonly context?: Record<string, unknown>;
 *
 *   constructor(message: string, context?: Record<string, unknown>) {
 *     super(message);
 *     this.name = 'ValidationError';
 *     this.timestamp = new Date();
 *     this.context = context;
 *   }
 *
 *   toJSON() {
 *     return {
 *       name: this.name,
 *       message: this.message,
 *       severity: this.severity,
 *       timestamp: this.timestamp.toISOString(),
 *       context: this.context,
 *     };
 *   }
 * }
 * ```
 */

/**
 * Уровень серьезности ошибки
 *
 * @remarks
 * Используется для приоритизации логирования и мониторинга.
 * - low: незначительные проблемы
 * - medium: требует внимания
 * - high: серьезная проблема
 * - critical: критическая ошибка, требует немедленного действия
 */
export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * ITradingError - общий интерфейс для всех ошибок
 *
 * @remarks
 * Каждая конкретная ошибка должна реализовать этот интерфейс.
 * Используется для унификации обработки ошибок в системе.
 * Каждая ошибка - это отдельный класс в отдельном файле.
 */
export interface ITradingError {
  /**
   * Название ошибки
   *
   * @remarks
   * Обычно совпадает с именем класса (например, "ValidationError").
   * Используется как уникальный идентификатор ошибки.
   */
  readonly name: string;

  /**
   * Код ошибки (опционально)
   *
   * @remarks
   * Дополнительный идентификатор для более детальной классификации.
   * Полезен когда один класс ошибки может иметь разные подтипы.
   *
   * @example
   * ```typescript
   * // ValidationError с разными кодами
   * new ValidationError('Invalid price', { code: 'PRICE_NEGATIVE' });
   * new ValidationError('Invalid quantity', { code: 'QUANTITY_ZERO' });
   * ```
   */
  readonly code?: string;

  /**
   * Человекочитаемое сообщение об ошибке
   */
  readonly message: string;

  /**
   * Уровень серьезности ошибки
   *
   * @remarks
   * - low: незначительные проблемы (например, валидация формы)
   * - medium: требует внимания (например, недостаточно средств)
   * - high: серьезная проблема (например, ошибка сети)
   * - critical: критическая ошибка, требует немедленного действия
   */
  readonly severity: ErrorSeverity;

  /**
   * Время возникновения ошибки
   */
  readonly timestamp: Date;

  /**
   * Дополнительный контекст
   *
   * @remarks
   * Может содержать любые данные, полезные для отладки:
   * - ID сущностей
   * - Параметры операции
   * - Состояние системы
   *
   * @example
   * ```typescript
   * {
   *   marketId: 'market-123',
   *   userId: 'user-456',
   *   field: 'price',
   *   value: -10
   * }
   * ```
   */
  readonly context?: Record<string, unknown>;

  /**
   * Внутренняя ошибка (опционально)
   *
   * @remarks
   * Используется для хранения оригинальной ошибки, которая была выброшена
   * из функции-шаблона сообщения или для цепочки ошибок.
   * Полезно для отладки и логирования.
   *
   * @example
   * ```typescript
   * // Ошибка из функции-шаблона сохраняется в innerError
   * const error = new ValidationError(
   *   (ctx) => { throw new Error('Template failed'); },
   *   { context: { field: 'price' } }
   * );
   * console.log(error.innerError); // Error: Template failed
   * ```
   */
  readonly innerError?: Error;

  /**
   * Сериализует ошибку в объект
   *
   * @returns Plain object с данными ошибки
   *
   * @remarks
   * Полезно для:
   * - Логирования
   * - API responses
   * - Передачи через network
   *
   * @example
   * ```typescript
   * const error = new ValidationError(
   *   'Invalid price',
   *   { field: 'price', value: -10 }
   * );
   *
   * console.log(JSON.stringify(error.toJSON()));
   * // {
   * //   "name": "ValidationError",
   * //   "message": "Invalid price",
   * //   "severity": "low",
   * //   "timestamp": "2024-01-15T10:30:00.000Z",
   * //   "context": { "field": "price", "value": -10 }
   * // }
   * ```
   */
  toJSON(): Record<string, unknown>;
}
