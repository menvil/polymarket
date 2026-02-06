/**
 * OutcomeIndex - индекс outcome в бинарном рынке
 *
 * @deprecated Используй OutcomeKey (BinaryOutcome.UP/DOWN). OutcomeIndex оставлен только для on-chain адаптеров.
 *
 * @remarks
 * **УСТАРЕВШИЙ ТИП** — переходи на OutcomeKey:
 * - OutcomeIndex: 0 = NO, 1 = YES (числа для on-chain)
 * - OutcomeKey: 'DOWN', 'UP' (строки для доменной логики)
 *
 * Используй OutcomeKey в core/domain коде.
 * OutcomeIndex оставлен только для адаптеров к on-chain протоколам (CTF).
 *
 * Для конверсии: `outcomeKeyToIndex()`, `indexToOutcomeKey()` из OutcomeKey.ts
 *
 * @example
 * ```typescript
 * // ❌ Старый способ (deprecated)
 * const yesOutcome: OutcomeIndex = 1;
 * const noOutcome: OutcomeIndex = 0;
 *
 * // ✅ Новый способ (используй это)
 * import { BinaryOutcome } from './OutcomeKey.js';
 * const upToken = BinaryOutcome.UP;   // 'UP'
 * const downToken = BinaryOutcome.DOWN; // 'DOWN'
 * ```
 */
export type OutcomeIndex = 0 | 1;

/**
 * Константы для читаемости
 *
 * @deprecated Используй BinaryOutcome.UP/DOWN из OutcomeKey.ts
 */
export const OutcomeIndex = {
  NO: 0 as OutcomeIndex,
  YES: 1 as OutcomeIndex,
} as const;

/**
 * Проверка что значение является валидным OutcomeIndex
 *
 * @deprecated Используй parseOutcomeKey() из OutcomeKey.ts
 */
export function isValidOutcomeIndex(value: unknown): value is OutcomeIndex {
  return value === 0 || value === 1;
}

/**
 * Получить противоположный outcome
 *
 * @deprecated Используй oppositeOutcomeKey() из OutcomeKey.ts
 */
export function oppositeOutcomeIndex(index: OutcomeIndex): OutcomeIndex {
  return index === 0 ? 1 : 0;
}

/**
 * @deprecated Переименован в oppositeOutcomeIndex. Используй oppositeOutcomeKey() из OutcomeKey.ts
 */
export const oppositeOutcome = oppositeOutcomeIndex;

/**
 * Преобразование OutcomeIndex в строку
 *
 * @deprecated Используй OutcomeKey напрямую (BinaryOutcome.UP/DOWN)
 */
export function outcomeIndexToString(index: OutcomeIndex): 'YES' | 'NO' {
  return index === 1 ? 'YES' : 'NO';
}

/**
 * Парсинг строки в OutcomeIndex
 *
 * @deprecated Используй parseOutcomeKey() из OutcomeKey.ts
 */
export function parseOutcomeIndex(str: string): OutcomeIndex | undefined {
  const upper = str.toUpperCase();
  if (upper === 'YES' || upper === '1') return 1;
  if (upper === 'NO' || upper === '0') return 0;
  return undefined;
}
