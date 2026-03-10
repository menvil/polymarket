/**
 * Core Side Value Object
 *
 * @remarks
 * Представляет направление торговой операции в системе.
 * Side это literal type ('BUY' | 'SELL') с utility методами.
 *
 * ## Отличие от OutcomeKey:
 * - **Side** (BUY/SELL) — направление СДЕЛКИ (агрессор в trade)
 * - **OutcomeKey** (UP/DOWN) — сторона OUTCOME токена
 *
 * ## Инварианты:
 * Side имеет только 2 валидных значения: 'BUY' или 'SELL'.
 * Любое другое значение невалидно.
 *
 * ## Паттерн:
 * Side это type alias (не class), так как:
 * - Нет сложного внутреннего состояния
 * - Нет инвариантов требующих защиты через private constructor
 * - Уже примитивное значение (string literal)
 * - Не требует Decimal.js или других value wrappers
 *
 * @example
 * ```typescript
 * import { Side, opposite, canMatch } from './Side';
 *
 * const buySide: Side = 'BUY';
 * const sellSide: Side = 'SELL';
 *
 * opposite(buySide);        // → 'SELL'
 * canMatch(buySide, sellSide); // → true
 * ```
 */
/**
 * Все валидные значения Side (замороженный массив)
 *
 * @remarks
 * Единственный источник правды для всех Side значений.
 * Object.freeze гарантирует runtime-иммутабельность:
 * попытка push() или delete через `as any` бросит TypeError в strict mode.
 * Используется для:
 * - Iteration через все стороны
 * - Runtime validation через SIDE_SET
 * - UI select options
 */
export const ALL_SIDES = Object.freeze(['BUY', 'SELL']);
/**
 * Набор валидных Side значений для O(1) lookup
 *
 * @remarks
 * Производный от ALL_SIDES — единственный источник правды.
 * Строится один раз при загрузке модуля.
 * Внутренний модуль, не экспортируется.
 */
const SIDE_SET = new Set(ALL_SIDES);
/**
 * Проверяет, является ли значение валидным Side
 *
 * @param value - Значение для проверки
 * @returns true если value это Side
 *
 * @throws {never} Функция не бросает исключений — безопасная type guard проверка.
 *
 * @remarks
 * Type guard для runtime проверки.
 * Использует SIDE_SET (производный от ALL_SIDES) для O(1) lookup —
 * добавление нового Side значения в ALL_SIDES автоматически обновляет эту проверку.
 *
 * @example
 * ```typescript
 * isValidSide('BUY');   // → true
 * isValidSide('SELL');  // → true
 * isValidSide('buy');   // → false (case sensitive)
 * isValidSide('FOO');   // → false
 * isValidSide(null);    // → false
 * ```
 */
export function isValidSide(value) {
    return typeof value === 'string' && SIDE_SET.has(value);
}
/**
 * Возвращает противоположную сторону
 *
 * @param side - Исходная сторона
 * @returns Противоположная сторона
 *
 * @remarks
 * Pure function - нет side effects.
 * - BUY → SELL
 * - SELL → BUY
 *
 * @example
 * ```typescript
 * opposite('BUY');  // → 'SELL'
 * opposite('SELL'); // → 'BUY'
 * ```
 */
export function opposite(side) {
    return side === 'BUY' ? 'SELL' : 'BUY';
}
/**
 * Проверяет совместимость двух сторон для matching
 *
 * @param side1 - Первая сторона
 * @param side2 - Вторая сторона
 * @returns true если стороны могут match
 *
 * @remarks
 * Match возможен только если стороны противоположные.
 * Используется в order matching engine.
 *
 * @example
 * ```typescript
 * canMatch('BUY', 'SELL');  // → true ✅
 * canMatch('SELL', 'BUY');  // → true ✅
 * canMatch('BUY', 'BUY');   // → false ❌
 * canMatch('SELL', 'SELL'); // → false ❌
 * ```
 */
export function canMatch(side1, side2) {
    return side1 !== side2;
}
/**
 * Сравнивает две стороны на равенство
 *
 * @param a - Первая сторона
 * @param b - Вторая сторона
 * @returns true если стороны одинаковые
 *
 * @remarks
 * Explicit equality helper для consistency с другими VO.
 * Для Side это просто `===`, но метод полезен для единообразия API.
 *
 * @example
 * ```typescript
 * equals('BUY', 'BUY');   // → true
 * equals('BUY', 'SELL');  // → false
 * ```
 */
export function equals(a, b) {
    return a === b;
}
//# sourceMappingURL=Side.js.map