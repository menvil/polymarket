import { validateBrandedId } from '../core/utils/validateBrandedId.js';
/**
 * Максимальная длина MarketId
 * @internal
 */
const MAX_MARKET_ID_LENGTH = 256;
/**
 * Валидация и парсинг MarketId
 *
 * @param raw - Строка для парсинга
 * @returns MarketId или undefined если формат невалидный
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
 * asMarketId('will-trump-win-2024'); // → MarketId
 * asMarketId('  valid  ');           // → 'valid' as MarketId (trimmed)
 * asMarketId('');                    // → undefined (пустая строка)
 * asMarketId('  ');                  // → undefined (только пробелы)
 * asMarketId('a\u0000b');           // → undefined (control character)
 * asMarketId('x'.repeat(300));      // → undefined (слишком длинная)
 * ```
 */
export function asMarketId(raw) {
    return validateBrandedId(raw, MAX_MARKET_ID_LENGTH);
}
/**
 * Unsafe constructor — bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns MarketId
 *
 * @remarks
 * Используй только если уверен что строка валидна (например, из БД или уже валидированного источника).
 * Для external input всегда используй asMarketId().
 */
/* c8 ignore next 3 */
export function unsafeMarketId(raw) {
    return raw;
}
//# sourceMappingURL=MarketId.js.map