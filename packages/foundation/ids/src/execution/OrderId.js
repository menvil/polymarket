import { validateBrandedId } from '../core/utils/validateBrandedId.js';
/**
 * Максимальная длина OrderId
 * @internal
 */
const MAX_ORDER_ID_LENGTH = 256;
/**
 * Валидация и парсинг OrderId
 *
 * @param raw - Строка для парсинга
 * @returns OrderId или undefined если формат невалидный
 *
 * @remarks
 * Базовые ограничения:
 * - Не пустая строка
 * - Максимум 256 символов
 * - Не содержит control characters (U+0000..U+001F, U+007F..U+009F)
 * - Не содержит пробелы по краям (автоматически trim)
 *
 * @example
 * ```typescript
 * asOrderId('order_123abc'); // → 'order_123abc' as OrderId
 * asOrderId('  valid  '); // → 'valid' as OrderId (trimmed)
 * asOrderId(''); // → undefined (пустая строка)
 * asOrderId('  '); // → undefined (только пробелы)
 * asOrderId('a\u0000b'); // → undefined (control character)
 * asOrderId('x'.repeat(300)); // → undefined (слишком длинная)
 * ```
 */
export function asOrderId(raw) {
    return validateBrandedId(raw, MAX_ORDER_ID_LENGTH);
}
/**
 * Unsafe constructor - bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns OrderId
 *
 * @remarks
 * Используй только если уверен что строка валидна.
 * Для external input всегда используй asOrderId().
 */
/* c8 ignore next 3 */
export function unsafeOrderId(raw) {
    return raw;
}
//# sourceMappingURL=OrderId.js.map