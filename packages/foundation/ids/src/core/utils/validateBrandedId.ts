/**
 * Общий валидатор для branded string ID
 *
 * @remarks
 * Выносит дублированную логику валидации из FillId, OrderId и InstrumentId
 * в единую функцию. Все три модуля используют одинаковый набор правил:
 * trim → non-empty → length → control characters.
 *
 * @packageDocumentation
 */

/**
 * Валидировать и нормализовать сырую строку для branded ID типов
 *
 * @param raw - Исходная строка для валидации
 * @param maxLength - Максимально допустимая длина после trim
 * @returns Trimmed строка если валидна, undefined если нет
 *
 * @remarks
 * Правила (в порядке проверки):
 * 1. Trim крайних пробелов
 * 2. Отклонить пустую строку
 * 3. Отклонить строки длиннее maxLength
 * 4. Отклонить строки с control characters (U+0000..U+001F, U+007F..U+009F) — проверка через charCodeAt
 *
 * @example
 * ```typescript
 * validateBrandedId('fill_456', 256); // → 'fill_456'
 * validateBrandedId('  valid  ', 256); // → 'valid' (trimmed)
 * validateBrandedId('', 256);          // → undefined (empty)
 * validateBrandedId('a\u0000b', 256);  // → undefined (control char)
 * validateBrandedId('x'.repeat(300), 256); // → undefined (too long)
 * ```
 */
export function validateBrandedId(raw: string, maxLength: number): string | undefined {
  // Guard against invalid maxLength (NaN, Infinity, negative) — NaN comparisons are always false,
  // which would silently bypass the length check below.
  if (!Number.isFinite(maxLength) || maxLength < 0) {
    return undefined;
  }

  // Trim whitespace
  const trimmed = raw.trim();

  // Non-empty check
  if (trimmed.length === 0) {
    return undefined;
  }

  // Length check
  if (trimmed.length > maxLength) {
    return undefined;
  }

  // Control characters check (U+0000..U+001F, U+007F..U+009F)
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      return undefined;
    }
  }

  return trimmed;
}
