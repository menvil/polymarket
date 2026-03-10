/**
 * OutcomeKey - универсальный ключ для outcome в рынке
 *
 * @remarks
 * Поддерживает:
 * - Бинарные рынки (UP/DOWN)
 * - Multi-outcome рынки (будущее расширение)
 * - Scalar рынки (будущее расширение)
 *
 * Архитектурное решение: использовать строковые ключи вместо числовых индексов
 * для лучшей расширяемости и читаемости.
 *
 * Для работы с on-chain индексами (контракты используют числа) используй:
 * - outcomeKeyToIndex() - конвертировать OutcomeKey → number для отправки в контракт
 * - indexToOutcomeKey() - конвертировать number → OutcomeKey при получении из контракта
 *
 * @example
 * ```typescript
 * // Использование констант (compile-time)
 * const upKey = BinaryOutcome.UP;
 * const downKey = BinaryOutcome.DOWN;
 *
 * // Парсинг runtime значений
 * const userKey = parseOutcomeKey(userInput);
 *
 * // Использование в AssetId — fromOutcomeToken возвращает Result, не бросает
 * const upResult = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
 * if (upResult.ok) {
 *   const upToken = upResult.value;
 * }
 *
 * // Mapping в on-chain index
 * const index = outcomeKeyToIndex(BinaryOutcome.UP); // → 1
 * const key = indexToOutcomeKey(0); // → BinaryOutcome.DOWN
 * ```
 */
export type OutcomeKey = string & {
    readonly __brand: 'OutcomeKey';
};
/**
 * Парсинг OutcomeKey из строки с валидацией
 *
 * @param raw - Строка для парсинга
 * @returns OutcomeKey или undefined если формат невалидный
 *
 * @remarks
 * Валидирует OutcomeKey:
 * - Не пустая строка
 * - Длина не более 32 символов
 * - Не содержит ':' или '\' (зарезервированы для сериализации/escaping)
 *
 * Используй эту функцию при парсинге данных из внешних источников
 * (API, сериализация, пользовательский ввод).
 *
 * Для создания известных ключей используй константы BinaryOutcome или unsafeOutcomeKey().
 *
 * @example
 * ```typescript
 * parseOutcomeKey('UP'); // → 'UP' as OutcomeKey
 * parseOutcomeKey('DOWN'); // → 'DOWN' as OutcomeKey
 * parseOutcomeKey('TEAM_A'); // → 'TEAM_A' as OutcomeKey
 *
 * // Валидация
 * parseOutcomeKey(''); // → undefined (пустая строка)
 * parseOutcomeKey('A'.repeat(33)); // → undefined (слишком длинная)
 * parseOutcomeKey('UP:DOWN'); // → undefined (содержит ':')
 * parseOutcomeKey('UP\\DOWN'); // → undefined (содержит '\')
 * ```
 */
export declare function parseOutcomeKey(raw: string): OutcomeKey | undefined;
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
 * import { AssetIdHelpers, BinaryOutcome } from '@polymarket/ids';
 *
 * // Price movement market: "BTC > $100k?"
 * // fromOutcomeToken — safe-контракт: Result, не throw
 * const upResult = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
 * const downResult = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.DOWN);
 * if (upResult.ok && downResult.ok) {
 *   const upToken = upResult.value;
 *   const downToken = downResult.value;
 * }
 *
 * // Mapping в on-chain index
 * outcomeKeyToIndex(BinaryOutcome.UP); // → 1
 * outcomeKeyToIndex(BinaryOutcome.DOWN); // → 0
 * ```
 */
export declare const BinaryOutcome: Readonly<{
    /**
     * DOWN = on-chain index 0
     *
     * Семантика: цена идёт вниз, событие не происходит, негативный исход
     */
    readonly DOWN: OutcomeKey;
    /**
     * UP = on-chain index 1
     *
     * Семантика: цена идёт вверх, событие происходит, позитивный исход
     */
    readonly UP: OutcomeKey;
}>;
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
 * @returns number для известных бинарных outcomes (0 или 1), undefined для неизвестных
 *
 * @example
 * ```typescript
 * outcomeKeyToIndex(BinaryOutcome.UP); // → 1
 * outcomeKeyToIndex(BinaryOutcome.DOWN); // → 0
 * outcomeKeyToIndex(unsafeOutcomeKey('UNKNOWN')); // → undefined
 * ```
 */
export declare function outcomeKeyToIndex(key: OutcomeKey): number | undefined;
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
 * @returns OutcomeKey для известных индексов (0 или 1), undefined для других
 *
 * @example
 * ```typescript
 * indexToOutcomeKey(0); // → BinaryOutcome.DOWN
 * indexToOutcomeKey(1); // → BinaryOutcome.UP
 * indexToOutcomeKey(2); // → undefined
 * ```
 */
export declare function indexToOutcomeKey(index: number): OutcomeKey | undefined;
/**
 * Сравнение двух OutcomeKey на равенство
 *
 * @param a - Первый OutcomeKey
 * @param b - Второй OutcomeKey
 * @returns true если ключи идентичны
 *
 * @remarks
 * Семантический хелпер для сравнения OutcomeKey.
 * Реализован через строгое равенство (`===`), так как OutcomeKey — branded string
 * с canonical форматом (parse уже нормализует ввод).
 *
 * Функция намеренно сохранена как часть публичного API вместо замены на прямое `===`,
 * чтобы:
 * - Поддерживать семантическое единообразие с другими equals-функциями в пакете
 *   (walletAddressEquals, currencyEquals, conditionRefEquals)
 * - Служить точкой расширения, если в будущем понадобится нормализация
 *   (например, case-insensitive сравнение для кастомных ключей)
 *
 * @example
 * ```typescript
 * outcomeKeyEquals(BinaryOutcome.UP, BinaryOutcome.UP); // → true
 * outcomeKeyEquals(BinaryOutcome.UP, BinaryOutcome.DOWN); // → false
 *
 * const key = parseOutcomeKey('TEAM_A')!;
 * outcomeKeyEquals(key, key); // → true
 * ```
 */
export declare function outcomeKeyEquals(a: OutcomeKey, b: OutcomeKey): boolean;
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
 * oppositeOutcomeKey(BinaryOutcome.UP); // → BinaryOutcome.DOWN
 * oppositeOutcomeKey(BinaryOutcome.DOWN); // → BinaryOutcome.UP
 * oppositeOutcomeKey(unsafeOutcomeKey('CUSTOM')); // → undefined
 * ```
 */
export declare function oppositeOutcomeKey(key: OutcomeKey): OutcomeKey | undefined;
//# sourceMappingURL=OutcomeKey.d.ts.map