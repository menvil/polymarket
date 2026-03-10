import { validateBrandedId } from '../core/utils/validateBrandedId.js';
/**
 * Максимальная длина VenueTradeId
 * @internal
 */
const MAX_VENUE_TRADE_ID_LENGTH = 512;
/**
 * Валидация и парсинг VenueTradeId
 *
 * @param raw - Строка для парсинга
 * @returns VenueTradeId или undefined если формат невалидный
 *
 * @remarks
 * Базовые ограничения:
 * - Не пустая строка
 * - Максимум 512 символов
 * - Не содержит control characters (U+0000..U+001F, U+007F..U+009F)
 * - Не содержит пробелы по краям (автоматически trim)
 *
 * @example
 * ```typescript
 * asVenueTradeId('0xabc123_1700000000000'); // → VenueTradeId
 * asVenueTradeId('  valid  ');              // → 'valid' as VenueTradeId (trimmed)
 * asVenueTradeId('');                       // → undefined (пустая строка)
 * asVenueTradeId('a\u0000b');              // → undefined (control character)
 * asVenueTradeId('x'.repeat(600));         // → undefined (слишком длинная)
 * ```
 */
export function asVenueTradeId(raw) {
    return validateBrandedId(raw, MAX_VENUE_TRADE_ID_LENGTH);
}
/**
 * Unsafe constructor - bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns VenueTradeId
 *
 * @remarks
 * Используй только если уверен что строка валидна.
 * Для external input всегда используй asVenueTradeId().
 */
/* c8 ignore next 3 */
export function unsafeVenueTradeId(raw) {
    return raw;
}
//# sourceMappingURL=VenueTradeId.js.map