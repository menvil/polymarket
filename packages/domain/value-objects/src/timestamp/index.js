/**
 * Timestamp module
 *
 * @remarks
 * Value object для представления временных меток (epoch milliseconds).
 *
 * **Архитектура:**
 * - Core: Timestamp - immutable VO с Decimal storage, throws on invalid
 * - Facade: TimestampService - публичный API с Result returns
 * - Adapters: Serializer и Formatter для JSON и отображения
 *
 * **Использование:**
 * Для создания Timestamp используйте TimestampService, не Core напрямую.
 * Core.of() предназначен только для внутреннего использования.
 *
 * @example
 * ```typescript
 * import { TimestampService } from '@polymarket/value-objects';
 *
 * // Создание из number
 * const result = TimestampService.create(Date.now());
 * if (result.ok) {
 *   console.log(result.value.toISO());
 * }
 * ```
 */
// Core
export { Timestamp, TimestampInvariantViolation } from './core/index.js';
// Facade
export { TimestampService } from './facade/index.js';
// Adapters
export { TimestampSerializer, TimestampFormatter } from './adapters/index.js';
// Errors
export { TimestampErrorReason } from './errors/index.js';
//# sourceMappingURL=index.js.map