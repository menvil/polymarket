import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError, InvalidOperandError } from '@polymarket/errors';
import { Quantity } from '../core/Quantity.js';
import { QuantityService } from '../facade/QuantityService.js';

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
 * JSON сериализатор для Quantity
 *
 * @remarks
 * ГРАНИЦА СИСТЕМЫ: принимает unknown, валидирует структуру.
 *
 * Отвечает за:
 * - Валидацию типов на границе (unknown → typed)
 * - Сериализацию/десериализацию JSON
 * - Читаемую диагностику через safeStringify
 * - Использует string для сохранения точности Decimal
 *
 * Для lossy сериализации (number) используй QuantityLossySerializer.
 *
 * @example
 * ```typescript
 * import { QuantitySerializer } from '@polymarket/value-objects/quantity';
 *
 * // Десериализация
 * const result = QuantitySerializer.fromJSON({ value: "10.5" });
 * if (result.ok) {
 *   console.log(result.value.toNumber()); // 10.5
 * }
 *
 * // Сериализация
 * const qty = expectOk(QuantityService.create(10.5));
 * const json = QuantitySerializer.toJSON(qty);
 * console.log(json); // { value: "10.5" }
 * ```
 */
export class QuantitySerializer {
  /**
   * Сериализует Quantity в JSON (string для точности)
   *
   * @remarks
   * Использует string для сохранения точности Decimal.
   *
   * @param quantity - Количество для сериализации
   * @returns JSON объект { value: string }
   *
   * @example
   * ```typescript
   * const qty = expectOk(QuantityService.create(10.5));
   * const json = QuantitySerializer.toJSON(qty);
   * console.log(json); // { value: "10.5" }
   * ```
   */
  public static toJSON(quantity: Quantity): { value: string } {
    return { value: quantity.value().toString() };
  }

  /**
   * Десериализует Quantity из JSON
   *
   * @remarks
   * Принимает unknown - граница валидации типов.
   * Валидирует структуру JSON перед парсингом.
   *
   * Этапы валидации:
   * 1. Проверка что json это объект (не null, array, primitive)
   * 2. Проверка наличия обязательного поля 'value'
   * 3. Проверка типа value (должен быть string)
   * 4. Делегирование QuantityService.create для бизнес-валидации
   *
   * @param json - JSON данные (unknown)
   * @returns Result с Quantity или InvalidQuantityError
   *
   * @example
   * ```typescript
   * // ✅ Валидные примеры
   * QuantitySerializer.fromJSON({ value: "10.5" });  // Ok
   *
   * // ❌ Структурные ошибки
   * QuantitySerializer.fromJSON(null);              // Err: expected object
   * QuantitySerializer.fromJSON({ });               // Err: missing field 'value'
   * QuantitySerializer.fromJSON({ value: 10 });     // Err: value must be string
   *
   * // ❌ Бизнес-ошибки (делегированы QuantityService)
   * QuantitySerializer.fromJSON({ value: "-1" });   // Err: negative quantity
   * ```
   */
  public static fromJSON(json: unknown): Result<Quantity, InvalidQuantityError> {
    // Проверка что это объект
    if (typeof json !== 'object' || json === null) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Expected object, got ${ctx.type}`,
          {
            context: {
              kind: 'invalid_json',
              type: typeof json,
              json: safeStringify(json)
            }
          }
        )
      );
    }

    // Проверка что это не массив
    if (Array.isArray(json)) {
      return Err(
        new InvalidQuantityError(
          () => `Expected object, got array`,
          {
            context: {
              kind: 'invalid_json',
              type: 'array',
              json: safeStringify(json)
            }
          }
        )
      );
    }

    // Проверка наличия поля value
    if (!('value' in json)) {
      return Err(
        new InvalidQuantityError(
          () => `Missing required field 'value'`,
          {
            context: {
              kind: 'invalid_json',
              type: 'missing_field',
              json: safeStringify(json)
            }
          }
        )
      );
    }

    const value = (json as { value: unknown }).value;

    // Проверка типа value (только string, не number!)
    if (typeof value !== 'string') {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Field 'value' must be string, got ${ctx.type}`,
          {
            context: {
              kind: 'invalid_json',
              type: typeof value,
              json: safeStringify(json)
            }
          }
        )
      );
    }

    // Делегируем создание QuantityService
    return QuantityService.create(value);
  }
}

/**
 * Lossy serializer для случаев когда точность не критична
 *
 * @remarks
 * ⚠️ ВНИМАНИЕ: Использует number, что может привести к потере точности.
 * Используйте только для отображения или когда точность не критична.
 * Для точной сериализации используйте QuantitySerializer.
 */
export class QuantityLossySerializer {
  /**
   * Сериализует Quantity в JSON (number, lossy)
   *
   * @remarks
   * ⚠️ ВНИМАНИЕ: Может потерять точность для больших чисел.
   *
   * @param quantity - Количество для сериализации
   * @returns Result с JSON объектом { value: number } или ошибкой
   *
   * @example
   * ```typescript
   * const result = QuantityLossySerializer.toJSON(qty);
   * if (result.ok) {
   *   console.log(result.value); // { value: 10.123456789 }
   * }
   * ```
   */
  public static toJSON(quantity: Quantity): Result<{ value: number }, InvalidOperandError> {
    const decimalValue = quantity.value();
    if (!decimalValue.isFinite()) {
      return Err(
        new InvalidOperandError(
          (ctx) => `Cannot serialize non-finite Quantity to JSON, got ${ctx.value}`,
          {
            context: {
              value: decimalValue.toString(),
              operation: 'toJSON'
            }
          }
        )
      );
    }
    return Ok({ value: quantity.toNumber() });
  }

  /**
   * Десериализует Quantity из JSON (number, lossy)
   *
   * @param json - JSON объект { value: number }
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityLossySerializer.fromJSON({ value: 10 });
   * ```
   */
  public static fromJSON(json: { value: number }): Result<Quantity, InvalidQuantityError> {
    return QuantityService.create(json.value);
  }
}
