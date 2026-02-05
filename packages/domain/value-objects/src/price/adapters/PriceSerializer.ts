import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError, InvalidOperandError, ErrorSource } from '@polymarket/errors';
import { Price } from '../core/Price.js';
import { PriceService } from '../facade/PriceService.js';

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
 * JSON контракт для Price сериализации
 *
 * @remarks
 * Используется как:
 * - Контракт API (документация структуры)
 * - Return type для toJSON()
 * - Type hint при создании JSON
 *
 * При парсинге (fromJSON) НЕ полагайся на этот тип -
 * делай полную runtime валидацию с unknown!
 */
export interface PriceJSON {
  /**
   * Price value as string для сохранения точности
   */
  value: string;
}

/**
 * JSON контракт для lossy сериализации (number)
 *
 * @remarks
 * ⚠️ ВНИМАНИЕ: Использует number, может привести к потере точности.
 * Для точной сериализации используй PriceJSON.
 */
export interface PriceLossyJSON {
  /**
   * Price value as number (может потерять точность)
   */
  value: number;
}

/**
 * JSON сериализатор для Price
 *
 * @remarks
 * ГРАНИЦА СИСТЕМЫ: принимает unknown, валидирует структуру.
 *
 * Отвечает за:
 * - Валидацию типов на границе (unknown → typed)
 * - Сериализацию/десериализацию JSON
 * - Читаемую диагностику через safeStringify
 *
 * Контракт:
 * - fromJSON НИКОГДА не доверяет типам, делает полную проверку
 * - toJSON ВСЕГДА возвращает валидный PriceJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { PriceSerializer } from '@polymarket/value-objects/price';
 *
 * // Десериализация
 * const result = PriceSerializer.fromJSON({ value: 0.5 });
 * if (result.ok) {
 *   console.log(result.value.toNumber()); // 0.5
 * }
 *
 * // Сериализация
 * const price = expectOk(PriceService.create(0.5));
 * const json = PriceSerializer.toJSON(price);
 * console.log(json); // { value: "0.5" }
 * ```
 */
export class PriceSerializer {
  private static readonly SERVICE_NAME = 'PriceSerializer';
  /**
   * Десериализует Price из JSON
   *
   * @remarks
   * Принимает unknown - граница валидации типов.
   * Валидирует структуру JSON перед парсингом.
   *
   * Этапы валидации:
   * 1. Проверка что json это объект (не null, array, primitive)
   * 2. Проверка наличия обязательного поля 'value'
   * 3. Проверка типа value (number или string)
   * 4. Делегирование PriceService.create для бизнес-валидации
   *
   * @param json - JSON данные (unknown)
   * @returns Result с Price или InvalidPriceError
   *
   * @example
   * ```typescript
   * // ✅ Валидные примеры
   * PriceSerializer.fromJSON({ value: 0.5 });    // Ok
   * PriceSerializer.fromJSON({ value: "0.5" });  // Ok
   *
   * // ❌ Структурные ошибки
   * PriceSerializer.fromJSON(null);              // Err: expected object
   * PriceSerializer.fromJSON({ });               // Err: missing field 'value'
   * PriceSerializer.fromJSON({ value: {} });     // Err: wrong type
   *
   * // ❌ Бизнес-ошибки (делегированы PriceService)
   * PriceSerializer.fromJSON({ value: 1.5 });    // Err: exceeds maximum
   * ```
   */
  public static fromJSON(json: unknown): Result<Price, InvalidPriceError> {
    // Проверка что это объект
    if (typeof json !== 'object' || json === null) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Expected object, got ${ctx.type}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: PriceSerializer.SERVICE_NAME,
              op: 'fromJSON',
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
        new InvalidPriceError(
          () => `Expected object, got array`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: PriceSerializer.SERVICE_NAME,
              op: 'fromJSON',
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
        new InvalidPriceError(
          () => `Missing required field 'value'`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: PriceSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_json',
              type: 'missing_field',
              json: safeStringify(json)
            }
          }
        )
      );
    }

    const value = (json as { value: unknown }).value;

    // Проверка типа value
    if (typeof value !== 'number' && typeof value !== 'string') {
      return Err(
        new InvalidPriceError(
          (ctx) => `Field 'value' must be number or string, got ${ctx.type}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: PriceSerializer.SERVICE_NAME,
              op: 'fromJSON',
              kind: 'invalid_json',
              type: typeof value,
              json: safeStringify(json)
            }
          }
        )
      );
    }

    // Делегируем создание PriceService
    return PriceService.create(value);
  }

  /**
   * Сериализует Price в JSON объект
   *
   * @param price - Price для сериализации
   * @returns PriceJSON объект с value (string)
   *
   * @remarks
   * Возвращает строго типизированный PriceJSON.
   * Используем string для value чтобы сохранить точность.
   * Гарантирует что все поля присутствуют и имеют правильные типы.
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * const json = PriceSerializer.toJSON(price);
   * console.log(json); // { value: "0.5" }
   * ```
   */
  public static toJSON(price: Price): PriceJSON {
    return {
      value: price.value().toString()
    };
  }
}

/**
 * Lossy serializer для случаев когда точность не критична
 *
 * @remarks
 * ⚠️ ВНИМАНИЕ: Использует number, что может привести к потере точности.
 * Используйте только для отображения или когда точность не критична.
 * Для точной сериализации используйте PriceSerializer.
 */
export class PriceLossySerializer {
  private static readonly SERVICE_NAME = 'PriceLossySerializer';

  /**
   * Сериализует Price в JSON объект (lossy)
   *
   * @param price - Price для сериализации
   * @returns Result с PriceLossyJSON или ошибкой
   *
   * @remarks
   * ⚠️ ВНИМАНИЕ: Может потерять точность для больших чисел.
   * Использует number вместо string.
   *
   * @example
   * ```typescript
   * const result = PriceLossySerializer.toJSON(price);
   * if (result.ok) {
   *   console.log(result.value); // { value: 0.5 }
   * }
   * ```
   */
  public static toJSON(price: Price): Result<PriceLossyJSON, InvalidOperandError> {
    const decimalValue = price.value();
    if (!decimalValue.isFinite()) {
      return Err(
        new InvalidOperandError(
          (ctx) => `Cannot serialize non-finite Price to JSON, got ${ctx.value}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: PriceLossySerializer.SERVICE_NAME,
              op: 'toJSON',
              value: decimalValue.toString(),
              operation: 'toJSON'
            }
          }
        )
      );
    }
    return Ok({ value: price.toNumber() });
  }

  /**
   * Десериализует Price из JSON (lossy)
   *
   * @param json - PriceLossyJSON объект { value: number }
   * @returns Result с Price или InvalidPriceError
   *
   * @example
   * ```typescript
   * const result = PriceLossySerializer.fromJSON({ value: 0.5 });
   * ```
   */
  public static fromJSON(json: PriceLossyJSON): Result<Price, InvalidPriceError> {
    return PriceService.create(json.value);
  }
}
