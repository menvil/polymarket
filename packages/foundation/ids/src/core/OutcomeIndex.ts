/**
 * OutcomeIndex - индекс outcome в бинарном рынке
 *
 * @remarks
 * Для бинарных рынков (YES/NO):
 * - 0 = NO
 * - 1 = YES
 *
 * Ограничен двумя значениями для type safety.
 *
 * @example
 * ```typescript
 * const yesOutcome: OutcomeIndex = 1;
 * const noOutcome: OutcomeIndex = 0;
 *
 * // ❌ TypeScript error
 * const invalid: OutcomeIndex = 2;
 * ```
 */
export type OutcomeIndex = 0 | 1;

/**
 * Константы для читаемости
 */
export const OutcomeIndex = {
  NO: 0 as OutcomeIndex,
  YES: 1 as OutcomeIndex,
} as const;

/**
 * Проверка что значение является валидным OutcomeIndex
 */
export function isValidOutcomeIndex(value: unknown): value is OutcomeIndex {
  return value === 0 || value === 1;
}

/**
 * Получить противоположный outcome
 */
export function oppositeOutcome(index: OutcomeIndex): OutcomeIndex {
  return index === 0 ? 1 : 0;
}

/**
 * Преобразование OutcomeIndex в строку
 */
export function outcomeIndexToString(index: OutcomeIndex): 'YES' | 'NO' {
  return index === 1 ? 'YES' : 'NO';
}

/**
 * Парсинг строки в OutcomeIndex
 */
export function parseOutcomeIndex(str: string): OutcomeIndex | undefined {
  const upper = str.toUpperCase();
  if (upper === 'YES' || upper === '1') return 1;
  if (upper === 'NO' || upper === '0') return 0;
  return undefined;
}
