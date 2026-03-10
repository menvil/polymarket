import { validateBrandedId } from './utils/validateBrandedId.js';
/**
 * Максимальная длина TxHash
 * @internal
 */
const MAX_TX_HASH_LENGTH = 132;
/**
 * Валидация и парсинг TxHash
 *
 * @param raw - Строка для парсинга
 * @returns TxHash или undefined если формат невалидный
 *
 * @remarks
 * Базовые ограничения:
 * - Не пустая строка
 * - Максимум 132 символа
 * - Не содержит control characters (U+0000..U+001F, U+007F..U+009F)
 * - Не содержит пробелы по краям (автоматически trim)
 *
 * @example
 * ```typescript
 * asTxHash('0xabc123...'); // → TxHash
 * asTxHash('  0xabc  ');  // → '0xabc' as TxHash (trimmed)
 * asTxHash('');            // → undefined (пустая строка)
 * asTxHash('a\u0000b');   // → undefined (control character)
 * ```
 */
export function asTxHash(raw) {
    return validateBrandedId(raw, MAX_TX_HASH_LENGTH);
}
/**
 * Unsafe constructor - bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns TxHash
 *
 * @remarks
 * Используй только если уверен что строка валидна.
 * Для external input всегда используй asTxHash().
 */
/* c8 ignore next 3 */
export function unsafeTxHash(raw) {
    return raw;
}
//# sourceMappingURL=TxHash.js.map