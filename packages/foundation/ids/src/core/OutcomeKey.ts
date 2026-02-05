/**
 * OutcomeKey - универсальный ключ для outcome в рынке
 *
 * @remarks
 * Замена для OutcomeIndex. Поддерживает:
 * - Бинарные рынки (UP/DOWN, бывшие YES/NO)
 * - Multi-outcome рынки (будущее расширение)
 * - Scalar рынки (будущее расширение)
 *
 * Архитектурное решение: использовать строковые ключи вместо числовых индексов
 * для лучшей расширяемости и читаемости.
 *
 * Для обратной совместимости с on-chain индексами используй mapping functions:
 * - outcomeKeyToIndex() - преобразовать в числовой индекс
 * - indexToOutcomeKey() - преобразовать из числового индекса
 *
 * @example
 * ```typescript
 * // Создание outcome key
 * const upKey = outcomeKey('UP');
 * const downKey = outcomeKey('DOWN');
 *
 * // Использование констант
 * const upToken = AssetId.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
 * const downToken = AssetId.fromOutcomeToken(conditionRef, BinaryOutcome.DOWN);
 *
 * // Mapping в on-chain index
 * const index = outcomeKeyToIndex(BinaryOutcome.UP); // → 1
 * const key = indexToOutcomeKey(0); // → BinaryOutcome.DOWN
 * ```
 */
export type OutcomeKey = string & { readonly __brand: 'OutcomeKey' };

/**
 * Создать OutcomeKey из строки
 *
 * @param key - Строковый ключ outcome (например, 'UP', 'DOWN', 'TEAM_A')
 * @returns OutcomeKey с type safety
 *
 * @remarks
 * Используй эту функцию для создания custom outcome keys.
 * Для стандартных бинарных рынков используй константы BinaryOutcome.UP/DOWN.
 *
 * @example
 * ```typescript
 * // Бинарный рынок
 * const up = outcomeKey('UP');
 * const down = outcomeKey('DOWN');
 *
 * // Multi-outcome рынок (future)
 * const teamA = outcomeKey('TEAM_A');
 * const teamB = outcomeKey('TEAM_B');
 * const draw = outcomeKey('DRAW');
 * ```
 */
export function outcomeKey(key: string): OutcomeKey {
  return key as OutcomeKey;
}

/**
 * Константы для бинарных рынков
 *
 * @remarks
 * UP/DOWN семантика вместо YES/NO для price movement markets.
 *
 * Mapping на on-chain индексы:
 * - DOWN = 0 (было NO)
 * - UP = 1 (было YES)
 *
 * @example
 * ```typescript
 * import { BinaryOutcome } from '@polymarket/ids';
 *
 * // Price movement market: "BTC > $100k?"
 * const upToken = AssetId.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
 * const downToken = AssetId.fromOutcomeToken(conditionRef, BinaryOutcome.DOWN);
 *
 * // Mapping в on-chain index
 * outcomeKeyToIndex(BinaryOutcome.UP); // → 1
 * outcomeKeyToIndex(BinaryOutcome.DOWN); // → 0
 * ```
 */
export const BinaryOutcome = {
  /**
   * DOWN = 0 (было NO в OutcomeIndex)
   *
   * Семантика: цена идёт вниз, событие не происходит, негативный исход
   */
  DOWN: outcomeKey('DOWN'),

  /**
   * UP = 1 (было YES в OutcomeIndex)
   *
   * Семантика: цена идёт вверх, событие происходит, позитивный исход
   */
  UP: outcomeKey('UP'),
} as const;

/**
 * Преобразовать OutcomeKey в on-chain index
 *
 * @param key - OutcomeKey для преобразования
 * @returns Числовой индекс (0 или 1) или undefined если key неизвестен
 *
 * @remarks
 * Используется для взаимодействия с on-chain контрактами, которые используют числовые индексы.
 *
 * Поддерживаемые mappings:
 * - BinaryOutcome.DOWN → 0
 * - BinaryOutcome.UP → 1
 *
 * @throws {undefined} Если key не является известным бинарным outcome
 *
 * @example
 * ```typescript
 * outcomeKeyToIndex(BinaryOutcome.UP); // → 1
 * outcomeKeyToIndex(BinaryOutcome.DOWN); // → 0
 * outcomeKeyToIndex(outcomeKey('UNKNOWN')); // → undefined
 * ```
 */
export function outcomeKeyToIndex(key: OutcomeKey): number | undefined {
  if (key === BinaryOutcome.DOWN) return 0;
  if (key === BinaryOutcome.UP) return 1;
  return undefined;
}

/**
 * Преобразовать on-chain index в OutcomeKey
 *
 * @param index - Числовой индекс (0 или 1)
 * @returns OutcomeKey или undefined если index неизвестен
 *
 * @remarks
 * Используется для преобразования данных из on-chain контрактов в доменные OutcomeKey.
 *
 * Поддерживаемые mappings:
 * - 0 → BinaryOutcome.DOWN
 * - 1 → BinaryOutcome.UP
 *
 * @throws {undefined} Если index не 0 и не 1
 *
 * @example
 * ```typescript
 * indexToOutcomeKey(0); // → BinaryOutcome.DOWN
 * indexToOutcomeKey(1); // → BinaryOutcome.UP
 * indexToOutcomeKey(2); // → undefined
 * ```
 */
export function indexToOutcomeKey(index: number): OutcomeKey | undefined {
  if (index === 0) return BinaryOutcome.DOWN;
  if (index === 1) return BinaryOutcome.UP;
  return undefined;
}

/**
 * Сравнение двух OutcomeKey на равенство
 *
 * @param a - Первый OutcomeKey
 * @param b - Второй OutcomeKey
 * @returns true если ключи идентичны
 *
 * @remarks
 * Простое строковое сравнение, так как OutcomeKey это branded string.
 *
 * @example
 * ```typescript
 * outcomeKeyEquals(BinaryOutcome.UP, BinaryOutcome.UP); // → true
 * outcomeKeyEquals(BinaryOutcome.UP, BinaryOutcome.DOWN); // → false
 *
 * const customKey1 = outcomeKey('TEAM_A');
 * const customKey2 = outcomeKey('TEAM_A');
 * outcomeKeyEquals(customKey1, customKey2); // → true
 * ```
 */
export function outcomeKeyEquals(a: OutcomeKey, b: OutcomeKey): boolean {
  return a === b;
}

/**
 * Получить противоположный outcome для бинарного рынка
 *
 * @param key - OutcomeKey (должен быть BinaryOutcome.UP или DOWN)
 * @returns Противоположный outcome или undefined если key не бинарный
 *
 * @remarks
 * Работает только для бинарных outcomes (UP/DOWN).
 * Для multi-outcome рынков эта функция не применима.
 *
 * @example
 * ```typescript
 * oppositeOutcome(BinaryOutcome.UP); // → BinaryOutcome.DOWN
 * oppositeOutcome(BinaryOutcome.DOWN); // → BinaryOutcome.UP
 * oppositeOutcome(outcomeKey('CUSTOM')); // → undefined
 * ```
 */
export function oppositeOutcome(key: OutcomeKey): OutcomeKey | undefined {
  if (key === BinaryOutcome.UP) return BinaryOutcome.DOWN;
  if (key === BinaryOutcome.DOWN) return BinaryOutcome.UP;
  return undefined;
}
