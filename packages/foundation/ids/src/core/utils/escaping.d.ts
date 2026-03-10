/**
 * Escaping utilities для сериализации ID с colon separators
 *
 * @remarks
 * Используется для безопасной сериализации строк содержащих ':' или '\' в составных ID.
 * Гарантирует round-trip serialization для:
 * - AccountId (wallet address, venue, subaccount name)
 * - ConditionRef (marketId для OFFCHAIN refs)
 *
 * Escaping rules:
 * - '\' → '\\'
 * - ':' → '\:'
 *
 * @packageDocumentation
 */
/**
 * Escape backslashes и colons в строке
 *
 * @param str - Строка для escaping
 * @returns Escaped строка где '\' → '\\' и ':' → '\:'
 *
 * @remarks
 * Порядок важен! Сначала экранируем backslash, потом colon.
 *
 * @example
 * ```typescript
 * escapeId('A:B');      // → 'A\\:B'
 * escapeId('A\\B');     // → 'A\\\\B'
 * escapeId('A\\:B');    // → 'A\\\\\\:B'
 * escapeId('normal');   // → 'normal'
 * ```
 */
export declare function escapeId(str: string): string;
/**
 * Unescape backslashes и colons в строке
 *
 * @param str - Escaped строка для парсинга
 * @returns Original строка с unescaped символами
 *
 * @remarks
 * Корректно обрабатывает:
 * - '\\\\' → '\' (escaped backslash)
 * - '\\:' → ':' (escaped colon)
 * - Любой другой '\X' остается как есть (не является escape sequence)
 *
 * @example
 * ```typescript
 * unescapeId('A\\:B');        // → 'A:B'
 * unescapeId('A\\\\B');       // → 'A\B'
 * unescapeId('A\\\\\\:B');    // → 'A\:B'
 * unescapeId('normal');       // → 'normal'
 * ```
 */
export declare function unescapeId(str: string): string;
/**
 * Split строку по ':' с учётом escaped separators
 *
 * @param str - Escaped строка для split
 * @returns Массив escaped частей (НЕ unescape'нутых!)
 *
 * @remarks
 * Корректно обрабатывает escaped colons ('\\:') - они НЕ являются separators.
 *
 * ⚠️ ВАЖНО: Возвращаемые части остаются escaped! Caller должен вызвать unescape()
 * на каждой части при необходимости.
 *
 * @example
 * ```typescript
 * splitEscaped('A:B:C');              // → ['A', 'B', 'C']
 * splitEscaped('A\\:B:C');            // → ['A\\:B', 'C'] (НЕ unescape'нуто!)
 * splitEscaped('A\\\\:B');            // → ['A\\\\', 'B']
 * splitEscaped('A\\\\\\:B:C');        // → ['A\\\\\\:B', 'C']
 * splitEscaped('');                   // → ['']
 *
 * // Чтобы получить unescape'нутые части:
 * const parts = splitEscaped('A\\:B:C').map(unescapeId);  // → ['A:B', 'C']
 * ```
 */
export declare function splitEscaped(str: string): string[];
//# sourceMappingURL=escaping.d.ts.map