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
 * asFillId('a\x00b'); // → undefined (control character)
 * asFillId('x'.repeat(300)); // → undefined (слишком длинная)
 * ```
 */
export function asFillId(raw: string): FillId | undefined {
  // Trim whitespace
  const trimmed = raw.trim();

  // Non-empty check
  if (trimmed.length === 0) {
    return undefined;
  }

  // Length check
  if (trimmed.length > MAX_FILL_ID_LENGTH) {
    return undefined;
  }

  // Control characters check
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/.test(trimmed)) {
    return undefined;
  }

  return trimmed as FillId;
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
export function unsafeFillId(raw: string): FillId {
  return raw as FillId;
}
