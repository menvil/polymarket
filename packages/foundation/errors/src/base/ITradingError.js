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
export {};
//# sourceMappingURL=ITradingError.js.map