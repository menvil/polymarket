/**
 * OrderId - идентификатор ордера
 *
 * @remarks
 * Branded type для type safety.
 *
 * Может быть:
 * - Venue order ID (от биржи)
 * - Internal order ID (наш внутренний)
 *
 * @example
 * ```typescript
 * const orderId = asOrderId('order_123abc')!;
 * ```
 */
export type OrderId = string & { readonly __brand: 'OrderId' };

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
 * asOrderId('a\x00b'); // → undefined (control character)
 * asOrderId('x'.repeat(300)); // → undefined (слишком длинная)
 * ```
 */
export function asOrderId(raw: string): OrderId | undefined {
  // Trim whitespace
  const trimmed = raw.trim();

  // Non-empty check
  if (trimmed.length === 0) {
    return undefined;
  }

  // Length check
  if (trimmed.length > MAX_ORDER_ID_LENGTH) {
    return undefined;
  }

  // Control characters check
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/.test(trimmed)) {
    return undefined;
  }

  return trimmed as OrderId;
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
export function unsafeOrderId(raw: string): OrderId {
  return raw as OrderId;
}
