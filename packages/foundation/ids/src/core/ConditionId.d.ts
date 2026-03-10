/**
 * ConditionId - идентификатор condition (хеш)
 *
 * @remarks
 * Branded type для type safety.
 * Представляет уникальный ID condition в протоколе.
 *
 * Обычно это:
 * - Hex string (0x...)
 * - Hash от параметров condition (keccak256, 32 байта)
 *
 * ⚠️ ВАЖНО: В большинстве случаев используй ConditionRef вместо голого ConditionId.
 * ConditionRef добавляет protocol и chain context, необходимый для однозначной идентификации.
 * Голый ConditionId допустим только для:
 * - Internal storage (когда protocol/chain известны из контекста)
 * - Validation и parsing
 * - Mapping/lookup в рамках одного протокола
 *
 * @example
 * ```typescript
 * const conditionId = '0xabc123...' as ConditionId;
 * ```
 */
export type ConditionId = string & {
    readonly __brand: 'ConditionId';
};
/**
 * Type guard для проверки валидности ConditionId
 *
 * @param id - Строка для проверки
 * @returns true если id является валидным ConditionId
 *
 * @remarks
 * Валидирует ConditionId:
 * - Должен начинаться с "0x"
 * - Должен содержать ровно 64 hex символа после "0x" (32 байта)
 * - Hex символы: 0-9, a-f, A-F
 *
 * ConditionId — это keccak256 hash (32 байта), представленный как hex string.
 *
 * @example
 * ```typescript
 * const valid = '0x' + 'a'.repeat(64);
 * isValidConditionId(valid); // → true
 *
 * isValidConditionId('0x12345678'); // → false (слишком короткий)
 * isValidConditionId('0xGGGGGG'); // → false (не hex символы)
 * isValidConditionId('abc123'); // → false (нет 0x префикса)
 * ```
 */
export declare function isValidConditionId(id: string): id is ConditionId;
/**
 * Парсинг ConditionId из строки с нормализацией
 *
 * @param str - Строка для парсинга
 * @returns ConditionId или undefined если формат невалидный
 *
 * @remarks
 * Парсит и нормализует ConditionId:
 * - Проверяет формат через isValidConditionId
 * - Приводит к lowercase для каноничности
 *
 * Нормализация гарантирует что "0xABC..." и "0xabc..." дают одинаковый ConditionId.
 *
 * Используй для:
 * - Парсинга из внешних источников (API, URL, конфиги)
 * - Десериализации
 * - Валидации user input
 *
 * @example
 * ```typescript
 * const hash = '0x' + 'AbCd'.repeat(16);
 * const conditionId = parseConditionId(hash);
 * // → нормализован в lowercase
 *
 * parseConditionId('0x12345678'); // → undefined (слишком короткий)
 * parseConditionId('garbage'); // → undefined (невалидный формат)
 * ```
 */
export declare function parseConditionId(str: string): ConditionId | undefined;
/**
 * Нормализация ConditionId в canonical form
 *
 * @param id - ConditionId для нормализации
 * @returns Нормализованный ConditionId (lowercase)
 *
 * @remarks
 * Приводит ConditionId к каноническому виду (lowercase).
 *
 * Используй когда:
 * - ConditionId уже существует, но нужно привести к canonical form
 * - Для сравнения или хранения в базе данных
 *
 * @example
 * ```typescript
 * const id = '0xABC123...' as ConditionId;
 * const normalized = normalizeConditionId(id);
 * // → '0xabc123...'
 * ```
 */
export declare function normalizeConditionId(id: ConditionId): ConditionId;
//# sourceMappingURL=ConditionId.d.ts.map