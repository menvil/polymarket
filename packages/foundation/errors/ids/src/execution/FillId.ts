import { validateBrandedId } from '../core/utils/validateBrandedId.js';

/**
 * FillId - идентификатор исполнения (fill/trade)
 *
 * @remarks
 * Branded type для type safety.
 *
 * Представляет уникальный ID исполнения ордера.
 *
 * @example
 * ```typescript
 * const fillId = asFillId('fill_456def')!;
 * ```
 */
export type FillId = string & { readonly __brand: 'FillId' };

/**
 * Максимальная длина FillId
 * @internal
 */
const MAX_FILL_ID_LENGTH = 256;

/**
 * Валидация и парсинг FillId
 *
 * @param raw - Строка для парсинга
 * @returns FillId или undefined если формат невалидный
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
 * asFillId('fill_456def'); // → 'fill_456def' as FillId
 * asFillId('  valid  '); // → 'valid' as FillId (trimmed)
 * asFillId(''); // → undefined (пустая строка)
 * asFillId('  '); // → undefined (только пробелы)
 * asFillId('a\u0000b'); // → undefined (control character)
 * asFillId('x'.repeat(300)); // → undefined (слишком длинная)
 * ```
 */
export function asFillId(raw: string): FillId | undefined {
  return validateBrandedId(raw, MAX_FILL_ID_LENGTH) as FillId | undefined;
}

/**
 * Unsafe constructor - bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns FillId
 *
 * @remarks
 * Используй только если уверен что строка валидна.
 * Для external input всегда используй asFillId().
 */
/* c8 ignore next 3 */
export function unsafeFillId(raw: string): FillId {
  return raw as FillId;
}
