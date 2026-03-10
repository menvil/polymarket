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
export type OrderId = string & {
    readonly __brand: 'OrderId';
};
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
export declare function asOrderId(raw: string): OrderId | undefined;
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
export declare function unsafeOrderId(raw: string): OrderId;
//# sourceMappingURL=OrderId.d.ts.map