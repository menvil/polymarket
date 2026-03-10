/**
 * PositionId - идентификатор позиции
 *
 * @remarks
 * Branded type для type safety.
 *
 * Представляет открытую/закрытую позицию по активу.
 * Позиция может состоять из нескольких лотов (FIFO/LIFO).
 *
 * Используется для:
 * - Tracking позиций в портфолио
 * - P&L расчеты
 * - Risk management
 * - Position lifecycle management
 *
 * @example
 * ```typescript
 * const positionId = asPositionId('pos_789xyz')!;
 * ```
 */
export type PositionId = string & {
    readonly __brand: 'PositionId';
};
/**
 * Валидация и парсинг PositionId
 *
 * @param raw - Строка для парсинга
 * @returns PositionId или undefined если формат невалидный
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
 * asPositionId('pos_789xyz'); // → 'pos_789xyz' as PositionId
 * asPositionId('  valid  '); // → 'valid' as PositionId (trimmed)
 * asPositionId(''); // → undefined (пустая строка)
 * asPositionId('  '); // → undefined (только пробелы)
 * asPositionId('a\u0000b'); // → undefined (control character)
 * asPositionId('x'.repeat(300)); // → undefined (слишком длинная)
 * ```
 */
export declare function asPositionId(raw: string): PositionId | undefined;
/**
 * Unsafe constructor - bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns PositionId
 *
 * @remarks
 * Используй только если уверен что строка валидна.
 * Для external input всегда используй asPositionId().
 */
export declare function unsafePositionId(raw: string): PositionId;
//# sourceMappingURL=PositionId.d.ts.map