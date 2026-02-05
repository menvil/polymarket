/**
 * ConditionId - идентификатор condition (хеш)
 *
 * @remarks
 * Branded type для type safety.
 * Представляет уникальный ID condition в протоколе.
 *
 * Обычно это:
 * - Hex string (0x...)
 * - Hash от параметров condition
 *
 * ⚠️ ВАЖНО: ConditionId НИКОГДА не используется отдельно!
 * Всегда используй ConditionRef (protocol + chain + condition).
 *
 * @example
 * ```typescript
 * const conditionId = '0xabc123...' as ConditionId;
 * ```
 */
export type ConditionId = string & { readonly __brand: 'ConditionId' };

/**
 * Проверка что строка похожа на hex hash
 */
export function isValidConditionId(id: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(id) && id.length >= 10;
}
