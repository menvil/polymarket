/**
 * @polymarket/errors - Error handling system
 *
 * @remarks
 * Этот пакет предоставляет систему обработки ошибок для trading системы.
 *
 * Архитектура:
 * - ITradingError интерфейс - общий контракт для всех ошибок
 * - TradingError класс - базовый класс с автоматическим name и toJSON
 * - ValidationError - пример базовой ошибки
 * - Severity для классификации ('low', 'medium', 'high', 'critical')
 * - Опциональный code для детальной классификации
 *
 * ### Sub-path экспорты:
 * - `@polymarket/errors` — базовые классы + foundation ошибки (этот модуль)
 * - `@polymarket/errors/base` — только TradingError, ValidationError, ITradingError
 * - `@polymarket/errors/value-objects` — ошибки value objects (InvalidPriceError, etc.)
 * - `@polymarket/errors/market` — ошибки жизненного цикла Market entity
 *
 * Использование:
 * ```typescript
 * import { TradingError, ErrorSeverity, ValidationError } from '@polymarket/errors';
 *
 * // Создание своей ошибки (7 строк!)
 * export class InsufficientFundsError extends TradingError {
 *   public readonly severity: ErrorSeverity = 'medium';
 *   constructor(message: string, options?: { code?: string; context?: Record<string, unknown> }) {
 *     super(message, options);
 *     // ✨ .is() метод наследуется автоматически!
 *   }
 * }
 *
 * // Выброс ошибки
 * throw new InsufficientFundsError('Not enough funds', { context: { required: 1000 } });
 *
 * // Проверка типа - 2 варианта
 * try {
 *   await operation();
 * } catch (error) {
 *   // Вариант 1: ValidationError.is() ✨ (короче!)
 *   if (ValidationError.is(error)) {
 *     console.log('Validation failed:', error.context);
 *   }
 *
 *   // Вариант 2: instanceof (стандартно)
 *   if (error instanceof InsufficientFundsError) {
 *     console.log('Not enough funds:', error.context);
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

// Base types, interfaces and classes
export * from './base/index.js';

// Value objects errors
export * from './value-objects/index.js';

// Math errors
export * from './math/index.js';

// ID errors
export * from './ids/index.js';

// Error handling utilities
export { ErrorSource } from './ErrorSource.js';
export * from './utils/errorUtils.js';
