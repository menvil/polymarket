/**
 * Serializer для Side - JSON conversion
 *
 * @remarks
 * Предоставляет методы для сериализации/десериализации Side в/из JSON.
 *
 * Для Side сериализация тривиальна (это уже string),
 * но Serializer предоставляет единообразный API для всех VO.
 *
 * @example
 * ```typescript
 * import { SideSerializer } from '@polymarket/value-objects';
 *
 * // Сериализация
 * const json = SideSerializer.toJSON('BUY'); // 'BUY'
 *
 * // Десериализация
 * const result = SideSerializer.fromJSON('SELL');
 * if (result.ok) {
 *   console.log(result.value); // 'SELL'
 * }
 * ```
 */

import { Result } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { Side } from '../core/index.js';
import { SideService } from '../facade/index.js';

/**
 * Класс SideSerializer - JSON serialization
 *
 * @remarks
 * Static-only class. Не создавайте экземпляры.
 */
export class SideSerializer {
  /**
   * Приватный конструктор - запрещает создание экземпляров
   */
  private constructor() {
    throw new Error('SideSerializer is a static class');
  }

  /**
   * Сериализовать Side в JSON
   *
   * @param side - Side для сериализации
   * @returns JSON представление (string)
   *
   * @remarks
   * Для Side это identity function (возвращает то же значение),
   * но метод полезен для единообразия API со сложными VO.
   *
   * @example
   * ```typescript
   * const json = SideSerializer.toJSON('BUY'); // 'BUY'
   * JSON.stringify({ side: json }); // '{"side":"BUY"}'
   * ```
   */
  public static toJSON(side: Side): string {
    return side;
  }

  /**
   * Десериализовать Side из JSON
   *
   * @param json - JSON string ('BUY' или 'SELL')
   * @returns Result<Side, ValidationError>
   *
   * @remarks
   * Валидирует что json это валидный Side.
   * Never throws - возвращает Result.
   *
   * @example
   * ```typescript
   * const result = SideSerializer.fromJSON('BUY');
   * if (result.ok) {
   *   console.log(result.value); // 'BUY'
   * }
   *
   * const invalid = SideSerializer.fromJSON('INVALID');
   * if (!invalid.ok) {
   *   console.error(invalid.error.message);
   * }
   * ```
   */
  public static fromJSON(json: string): Result<Side, ValidationError> {
    return SideService.fromString(json);
  }

  /**
   * Десериализовать Side из unknown значения
   *
   * @param json - Любое значение из JSON.parse()
   * @returns Result<Side, ValidationError>
   *
   * @remarks
   * Универсальный метод для парсинга JSON объектов.
   * Проверяет тип и валидирует значение.
   *
   * @example
   * ```typescript
   * const parsed: unknown = JSON.parse('{"side":"BUY"}');
   * const obj = parsed as { side: unknown };
   *
   * const result = SideSerializer.fromUnknown(obj.side);
   * if (result.ok) {
   *   const side: Side = result.value; // Type-safe
   * }
   * ```
   */
  public static fromUnknown(json: unknown): Result<Side, ValidationError> {
    return SideService.fromUnknown(json);
  }
}
