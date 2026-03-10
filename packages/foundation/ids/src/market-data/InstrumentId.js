import { validateBrandedId } from '../core/utils/validateBrandedId.js';
/**
 * Максимальная длина InstrumentId
 * @internal
 */
const MAX_INSTRUMENT_ID_LENGTH = 128;
/**
 * Валидация и парсинг InstrumentId
 *
 * @param raw - Строка для парсинга
 * @returns InstrumentId или undefined если формат невалидный
 *
 * @remarks
 * Базовые ограничения (venue-agnostic):
 * - Не пустая строка
 * - Максимум 128 символов
 * - Не содержит control characters (U+0000..U+001F, U+007F..U+009F)
 * - Не содержит пробелы по краям (автоматически trim)
 *
 * Для venue-specific валидации используй separate venue parsers
 * или check формат после парсинга.
 *
 * @example
 * ```typescript
 * asInstrumentId('123456789'); // → '123456789' as InstrumentId (Polymarket token_id)
 * asInstrumentId('INXD-23DEC31-T4120'); // → 'INXD-23DEC31-T4120' as InstrumentId (Kalshi ticker)
 * asInstrumentId('  valid  '); // → 'valid' as InstrumentId (trimmed)
 * asInstrumentId(''); // → undefined (пустая строка)
 * asInstrumentId('  '); // → undefined (только пробелы)
 * asInstrumentId('a\u0000b'); // → undefined (control character)
 * asInstrumentId('x'.repeat(200)); // → undefined (слишком длинная)
 * ```
 */
export function asInstrumentId(raw) {
    return validateBrandedId(raw, MAX_INSTRUMENT_ID_LENGTH);
}
/**
 * Unsafe constructor - bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns InstrumentId
 *
 * @remarks
 * Используй только если уверен что строка валидна.
 * Для external input всегда используй asInstrumentId().
 */
/* c8 ignore next 3 */
export function unsafeInstrumentId(raw) {
    return raw;
}
//# sourceMappingURL=InstrumentId.js.map