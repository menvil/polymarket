/**
 * Фасад для работы с Side - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с Side.
 * Предоставляет Result-based API для создания и валидации.
 *
 * **Контракт "Never Throw":**
 * Все **public static** методы никогда не бросают исключений.
 * - Методы парсинга/создания (`fromString`, `fromUnknown`) возвращают `Result<Side, InvalidSideError>`.
 * - Утилиты (`opposite`, `canMatch`, `equals`, `isValid`, `getAllValues`) возвращают значения напрямую.
 *
 * @example
 * ```typescript
 * import { SideService } from '@polymarket/value-objects';
 *
 * // Создание из строки
 * const result = SideService.fromString('BUY');
 * if (result.ok) {
 *   const side = result.value; // 'BUY'
 * }
 *
 * // Валидация
 * const isValid = SideService.isValid('SELL'); // true
 *
 * // Утилиты
 * const oppositeSide = SideService.opposite('BUY'); // 'SELL'
 * const canMatchSides = SideService.canMatch('BUY', 'SELL'); // true
 * ```
 */
import { Ok } from '@polymarket/result';
import { InvalidSideError, wrapOp } from '@polymarket/errors';
import { isValidSide, ALL_SIDES, opposite, canMatch, equals } from '../core/index.js';
import { SideErrorReason } from '../errors/index.js';
/**
 * Класс SideService - публичный API для Side
 *
 * @remarks
 * Static-only class. Не создавайте экземпляры.
 */
export class SideService {
    /**
     * Название сервиса для error tracking
     */
    static SERVICE_NAME = 'SideService';
    /**
     * Приватный конструктор - запрещает создание экземпляров
     */
    constructor() { }
    /**
     * Внутренний хелпер: парсит строку в Side или бросает InvalidSideError.
     *
     * @remarks
     * Без wrapOp — используется внутри fromString и fromUnknown,
     * каждый из которых имеет собственный wrapOp.
     * Это исключает двойную обёртку контекста при вызове изнутри fromUnknown.
     */
    static parseSideOrThrow(value) {
        if (isValidSide(value)) {
            return value;
        }
        throw new InvalidSideError((ctx) => `Invalid side value: ${ctx.value}. Expected ${ALL_SIDES.join(' or ')}`, {
            context: {
                kind: 'invalid_side_value',
                value,
                expectedValues: [...ALL_SIDES],
                reason: SideErrorReason.INVALID_VALUE,
            },
        });
    }
    /**
     * Создать Side из строки с валидацией
     *
     * @param value - Строковое значение ('BUY' или 'SELL')
     * @returns Result<Side, InvalidSideError>
     *
     * @remarks
     * Никогда не бросает исключения - всегда возвращает Result.
     * Case-sensitive: только 'BUY' и 'SELL' валидны.
     *
     * Содержит runtime type guard: TypeScript предотвращает передачу не-string
     * в compile time, но вызов через `as any` обходит это. В таком случае
     * возвращается `reason: INVALID_TYPE` — консистентно с `fromUnknown`.
     *
     * @example
     * ```typescript
     * const result1 = SideService.fromString('BUY');
     * if (result1.ok) {
     *   console.log(result1.value); // 'BUY'
     * }
     *
     * const result2 = SideService.fromString('buy');
     * if (!result2.ok) {
     *   console.error(result2.error.message); // Invalid side value: buy
     * }
     * ```
     */
    static fromString(value) {
        return wrapOp(SideService.SERVICE_NAME, 'fromString', { value }, () => {
            // Runtime type guard: консистентно с fromUnknown, чтобы INVALID_TYPE
            // всегда означало «не строка», независимо от точки входа.
            if (typeof value !== 'string') {
                const actualTag = Object.prototype.toString.call(value);
                throw new InvalidSideError((ctx) => `Invalid side: must be string, got ${ctx.actualTag}`, {
                    context: {
                        kind: 'invalid_side_type',
                        value,
                        type: typeof value,
                        actualTag,
                        reason: SideErrorReason.INVALID_TYPE,
                    },
                });
            }
            return Ok(SideService.parseSideOrThrow(value));
        }, InvalidSideError);
    }
    /**
     * Создать Side из unknown значения с валидацией
     *
     * @param value - Любое значение для проверки
     * @returns Result<Side, InvalidSideError>
     *
     * @remarks
     * Универсальный метод для парсинга из любого источника (API, DB, user input).
     * Проверяет что value это string И что это валидный Side.
     * Использует единый wrapOp без вложенных обёрток.
     *
     * Context включает `actualTag` (Object.prototype.toString) для различия
     * null / Array / Object — typeof возвращает 'object' для всех трёх.
     *
     * @example
     * ```typescript
     * const userInput: unknown = 'BUY';
     * const result = SideService.fromUnknown(userInput);
     * if (result.ok) {
     *   const side: Side = result.value; // Type-safe
     * }
     *
     * const invalidInput: unknown = null;
     * const result2 = SideService.fromUnknown(invalidInput);
     * if (!result2.ok) {
     *   console.error(result2.error.message); // Invalid side: must be string, got [object Null]
     * }
     * ```
     */
    static fromUnknown(value) {
        return wrapOp(SideService.SERVICE_NAME, 'fromUnknown', { value }, () => {
            if (typeof value !== 'string') {
                const actualTag = Object.prototype.toString.call(value);
                throw new InvalidSideError((ctx) => `Invalid side: must be string, got ${ctx.actualTag}`, {
                    context: {
                        kind: 'invalid_side_type',
                        value,
                        type: typeof value,
                        actualTag,
                        reason: SideErrorReason.INVALID_TYPE,
                    },
                });
            }
            return Ok(SideService.parseSideOrThrow(value));
        }, InvalidSideError);
    }
    /**
     * Проверить валидность Side (без создания Result)
     *
     * @param value - Значение для проверки
     * @returns true если value это валидный Side
     *
     * @remarks
     * Type guard - быстрая проверка без создания Result объекта.
     * Используйте когда нужна только boolean проверка.
     *
     * @example
     * ```typescript
     * if (SideService.isValid('BUY')) {
     *   console.log('Valid side');
     * }
     *
     * SideService.isValid('SELL');  // true
     * SideService.isValid('buy');   // false
     * SideService.isValid(null);    // false
     * ```
     */
    static isValid(value) {
        return isValidSide(value);
    }
    /**
     * Получить противоположную сторону
     *
     * @param side - Исходная сторона
     * @returns Противоположная сторона
     *
     * @remarks
     * Pure function - безопасная трансформация.
     * - BUY → SELL
     * - SELL → BUY
     *
     * @example
     * ```typescript
     * SideService.opposite('BUY');  // 'SELL'
     * SideService.opposite('SELL'); // 'BUY'
     *
     * // Использование в hedging
     * const hedgeSide = SideService.opposite(originalOrder.side);
     * ```
     */
    static opposite(side) {
        return opposite(side);
    }
    /**
     * Проверить совместимость сторон для matching
     *
     * @param side1 - Первая сторона
     * @param side2 - Вторая сторона
     * @returns true если стороны могут match в order book
     *
     * @remarks
     * Match возможен только если стороны противоположные.
     *
     * @example
     * ```typescript
     * SideService.canMatch('BUY', 'SELL');  // true ✅
     * SideService.canMatch('BUY', 'BUY');   // false ❌
     *
     * // Order matching validation
     * if (SideService.canMatch(order.side, trade.side)) {
     *   applyTrade(order, trade);
     * }
     * ```
     */
    static canMatch(side1, side2) {
        return canMatch(side1, side2);
    }
    /**
     * Сравнить две стороны на равенство
     *
     * @param a - Первая сторона
     * @param b - Вторая сторона
     * @returns true если стороны одинаковые
     *
     * @remarks
     * Явное сравнение для consistency с другими VO API.
     *
     * @example
     * ```typescript
     * SideService.equals('BUY', 'BUY');   // true
     * SideService.equals('BUY', 'SELL');  // false
     * ```
     */
    static equals(a, b) {
        return equals(a, b);
    }
    /**
     * Получить все валидные значения Side
     *
     * @returns Readonly массив всех Side значений
     *
     * @remarks
     * Единственный источник правды — возвращает ALL_SIDES из core.
     * Используется для UI select options, validation, iteration.
     *
     * @example
     * ```typescript
     * const allSides = SideService.getAllValues(); // ['BUY', 'SELL']
     *
     * // UI dropdown options
     * const options = SideService.getAllValues().map(side => ({
     *   value: side,
     *   label: side
     * }));
     * ```
     */
    static getAllValues() {
        return ALL_SIDES;
    }
}
//# sourceMappingURL=SideService.js.map