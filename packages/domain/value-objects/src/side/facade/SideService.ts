/**
 * Фасад для работы с Side - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с Side.
 * Предоставляет Result-based API для создания и валидации.
 *
 * **Контракт "Never Throw":**
 * Все методы ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
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

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { Side } from '../core/index.js';
import { isValidSide, opposite, canMatch, equals } from '../core/index.js';
import { SideErrorReason } from '../errors/index.js';

/**
 * Класс SideService - публичный API для Side
 *
 * @remarks
 * Static-only class. Не создавайте экземпляры.
 */
export class SideService {
  /**
   * Приватный конструктор - запрещает создание экземпляров
   */
  private constructor() {
    throw new Error('SideService is a static class');
  }

  /**
   * Создать Side из строки с валидацией
   *
   * @param value - Строковое значение ('BUY' или 'SELL')
   * @returns Result<Side, ValidationError>
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
  public static fromString(value: string): Result<Side, ValidationError> {
    if (isValidSide(value)) {
      return Ok(value);
    }

    return Err(
      new ValidationError(`Invalid side value: ${value}. Expected 'BUY' or 'SELL'`, {
        context: {
          field: 'side',
          value,
          expectedValues: ['BUY', 'SELL'],
          reason: SideErrorReason.INVALID_VALUE,
        },
      })
    );
  }

  /**
   * Создать Side из unknown значения с валидацией
   *
   * @param value - Любое значение для проверки
   * @returns Result<Side, ValidationError>
   *
   * @remarks
   * Универсальный метод для парсинга из любого источника (API, DB, user input).
   * Проверяет что value это string И что это валидный Side.
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
  public static fromUnknown(value: unknown): Result<Side, ValidationError> {
    if (typeof value !== 'string') {
      return Err(
        new ValidationError('Invalid side: must be string', {
          context: {
            field: 'side',
            value,
            type: typeof value,
            reason: SideErrorReason.INVALID_TYPE,
          },
        })
      );
    }

    return this.fromString(value);
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
    return ['BUY', 'SELL'] as const;
  }
}
