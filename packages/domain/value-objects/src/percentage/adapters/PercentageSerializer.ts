import { Result, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import { Percentage } from '../core/Percentage';
import { PercentageService } from '../facade/PercentageService';
import { PercentageErrorReason } from '../errors/PercentageErrorReason';

/**
 * Безопасная сериализация в JSON с обработкой циклических ссылок
 *
 * @param value - Значение для сериализации
 * @returns JSON строка
 *
 * @remarks
 * Заменяет циклические ссылки на "[Circular]" вместо выброса исключения.
 * Используется для читаемой диагностики ошибок.
 */
function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    });
  } catch {
    return '[Unstringifiable]';
  }
}

/**
 * JSON сериализатор для Percentage
 *
 * @remarks
 * ГРАНИЦА СИСТЕМЫ: принимает unknown, валидирует структуру.
 *
 * Отвечает за:
 * - Валидацию типов на границе (unknown → typed)
 * - Сериализацию/десериализацию JSON
 * - Читаемую диагностику через safeStringify
 *
 * @example
 * ```typescript
 * import { PercentageSerializer } from '@polymarket/value-objects/percentage';
 *
 * // Десериализация
 * const result = PercentageSerializer.fromJSON({ value: 50 });
 * if (result.ok) {
 *   console.log(result.value.toNumber()); // 50
 * }
 *
 * // Сериализация
 * const pct = Percentage.of(50);
 * const json = PercentageSerializer.toJSON(pct);
 * console.log(json); // { value: "50" }
 * ```
 */
export class PercentageSerializer {
  /**
   * Десериализует Percentage из JSON
   *
   * @remarks
   * Принимает unknown - граница валидации типов.
   * Валидирует структуру JSON перед парсингом.
   *
   * Этапы валидации:
   * 1. Проверка что json это объект (не null, array, primitive)
   * 2. Проверка наличия обязательного поля 'value'
   * 3. Проверка типа поля value
   * 4. Делегирование PercentageService.create для бизнес-валидации
   *
   * @param json - JSON данные (unknown)
   * @returns Result с Percentage или InvalidPercentageError
   *
   * @example
   * ```typescript
   * // ✅ Валидные примеры
   * PercentageSerializer.fromJSON({ value: 50 });
   * PercentageSerializer.fromJSON({ value: "50.5" });
   * PercentageSerializer.fromJSON({ value: 0 });
   *
   * // ❌ Невалидные примеры
   * PercentageSerializer.fromJSON(null);                   // not an object
   * PercentageSerializer.fromJSON({ val: 50 });            // missing value field
   * PercentageSerializer.fromJSON({ value: null });        // invalid value type
   * PercentageSerializer.fromJSON({ value: true });        // invalid value type
   * ```
   */
  public static fromJSON(json: unknown): Result<Percentage, InvalidPercentageError> {
    // 1. Проверка что json - объект
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      return Err(
        new InvalidPercentageError(`Expected object, got ${typeof json}`, {
          context: {
            op: 'fromJSON',
            json: safeStringify(json),
            reason: PercentageErrorReason.INVALID_FORMAT,
          },
        })
      );
    }

    const obj = json as Record<string, unknown>;

    // 2. Проверка наличия поля value
    if (!('value' in obj)) {
      return Err(
        new InvalidPercentageError(`Missing required field 'value'`, {
          context: {
            op: 'fromJSON',
            json: safeStringify(json),
            reason: PercentageErrorReason.INVALID_FORMAT,
          },
        })
      );
    }

    // 3. Проверка типа value
    const { value } = obj;
    if (typeof value !== 'number' && typeof value !== 'string') {
      return Err(
        new InvalidPercentageError(`Field 'value' must be number or string`, {
          context: {
            op: 'fromJSON',
            value: safeStringify(value),
            reason: PercentageErrorReason.INVALID_FORMAT,
          },
        })
      );
    }

    // 4. Делегирование бизнес-валидации PercentageService
    return PercentageService.create(value);
  }

  /**
   * Сериализует Percentage в JSON
   *
   * @remarks
   * Возвращает plain object с полем value (string).
   * Используем string для value чтобы избежать потери точности.
   *
   * @param pct - Percentage для сериализации
   * @returns Plain object { value: string }
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(50);
   * const json = PercentageSerializer.toJSON(pct);
   * console.log(json); // { value: "50" }
   *
   * // Можно сериализовать в JSON строку
   * const jsonString = JSON.stringify(json);
   * console.log(jsonString); // '{"value":"50"}'
   *
   * const pct2 = Percentage.of(50.5);
   * const json2 = PercentageSerializer.toJSON(pct2);
   * console.log(json2); // { value: "50.5" }
   * ```
   */
  public static toJSON(pct: Percentage): { value: string } {
    return {
      value: pct.value().toString(),
    };
  }
}
