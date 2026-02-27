/**
 * Фасад для работы с Side - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с Side.
 * Предоставляет Result-based API для создания и валидации.
 *
 * **Контракт "Never Throw":**
 * Все **public static** методы гарантированно возвращают Result и никогда не бросают исключения.
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

import { Result, Ok } from '@polymarket/result';
import { InvalidSideError, wrapOp } from '@polymarket/errors';
import { type Side, isValidSide, ALL_SIDES, opposite, canMatch, equals } from '../core/index.js';
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
  private static readonly SERVICE_NAME = 'SideService';

  /**
   * Приватный конструктор - запрещает создание экземпляров
   */
  private constructor() {}

  /**
   * Внутренний хелпер: парсит строку в Side или бросает InvalidSideError.
   *
   * @remarks
   * Без wrapOp — используется внутри fromString и fromUnknown,
   * каждый из которых имеет собственный wrapOp.
   * Это исключает двойную обёртку контекста при вызове изнутри fromUnknown.
   */
  private static parseSideOrThrow(value: string): Side {
    if (isValidSide(value)) {
      return value;
    }
    throw new InvalidSideError(
      (ctx) => `Invalid side value: ${ctx.value}. Expected ${ALL_SIDES.join(' or ')}`,
      {
        context: {
          kind: 'invalid_side_value',
          value,
          expectedValues: [...ALL_SIDES],
          reason: SideErrorReason.INVALID_VALUE,
        },
      }
    );
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
  public static fromString(value: string): Result<Side, InvalidSideError> {
    return wrapOp(
      SideService.SERVICE_NAME,
      'fromString',
      { value },
      () => Ok(SideService.parseSideOrThrow(value)),
      InvalidSideError
    );
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
   * @example
   * ```typescript
   * const userInput: unknown = 'BUY';
   * const result = SideService.fromUnknown(userInput);
   * if (result.ok) {
   *   const side: Side = result.value; // Type-safe
   * }
   *
   * const invalidInput: unknown = 123;
   * const result2 = SideService.fromUnknown(invalidInput);
   * if (!result2.ok) {
   *   console.error(result2.error.message); // Invalid side: must be string
   * }
   * ```
   */
  public static fromUnknown(value: unknown): Result<Side, InvalidSideError> {
    return wrapOp(
      SideService.SERVICE_NAME,
      'fromUnknown',
      { value },
      () => {
        if (typeof value !== 'string') {
          throw new InvalidSideError(
            (ctx) => `Invalid side: must be string, got ${ctx.type}`,
            {
              context: {
                kind: 'invalid_side_type',
                value,
                type: typeof value,
                reason: SideErrorReason.INVALID_TYPE,
              },
            }
          );
        }

        return Ok(SideService.parseSideOrThrow(value));
      },
      InvalidSideError
    );
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
  public static isValid(value: unknown): value is Side {
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
  public static opposite(side: Side): Side {
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
  public static canMatch(side1: Side, side2: Side): boolean {
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
  public static equals(a: Side, b: Side): boolean {
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
  public static getAllValues(): readonly Side[] {
    return ALL_SIDES;
  }
}
