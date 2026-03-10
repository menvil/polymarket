/**
 * TxHash - хэш блокчейн-транзакции
 *
 * @remarks
 * Branded type для type safety.
 *
 * Представляет хэш транзакции в блокчейне (например Ethereum tx hash).
 * Ethereum tx hash: 0x + 64 hex символов = 66 символов.
 * Максимальная длина 132 символа для поддержки различных форматов хэшей.
 *
 * @example
 * ```typescript
 * // 0x + 64 hex символов = 66 символов (Ethereum tx hash)
 * const hash = asTxHash('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890')!;
 * ```
 */
export type TxHash = string & {
    readonly __brand: 'TxHash';
};
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
export declare function asTxHash(raw: string): TxHash | undefined;
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
export declare function unsafeTxHash(raw: string): TxHash;
//# sourceMappingURL=TxHash.d.ts.map