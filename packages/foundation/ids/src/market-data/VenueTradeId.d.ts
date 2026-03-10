/**
 * VenueTradeId - идентификатор рыночного трейда (market print) на бирже
 *
 * @remarks
 * Branded type для type safety.
 *
 * Представляет уникальный ID трейда на конкретной торговой площадке (venue).
 * Используется в Trade entity (market tape) для идентификации рыночных принтов.
 * Максимальная длина 512 символов — учитывает длинные хэши транзакций + постфиксы.
 *
 * @example
 * ```typescript
 * const tradeId = asVenueTradeId('0xabc123_1700000000000')!;
 * // Генерация из txHash + timestamp:
 * const composed = asVenueTradeId(`${txHash}_${timestampMs}`)!;
 * ```
 */
export type VenueTradeId = string & {
    readonly __brand: 'VenueTradeId';
};
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
export declare function asVenueTradeId(raw: string): VenueTradeId | undefined;
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
export declare function unsafeVenueTradeId(raw: string): VenueTradeId;
//# sourceMappingURL=VenueTradeId.d.ts.map