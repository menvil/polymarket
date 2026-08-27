import { Result, Err } from '@polymarket/result';
import { InvalidSignedQuantityError, ErrorSource } from '@polymarket/errors';
import { SignedQuantity } from '../core/SignedQuantity.js';
import { SignedQuantityService } from '../facade/SignedQuantityService.js';
import type { JsonFailure } from '../../shared/json/index.js';
import {
  jsonFailureMessage,
  jsonFailureType,
  readField,
  readJsonObject,
  safeStringify,
} from '../../shared/json/index.js';

/**
 * JSON контракт для SignedQuantity сериализации
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
export interface SignedQuantityJSON {
  /**
   * SignedQuantity value as string для сохранения точности
   * Может быть отрицательным: "-10.5", "10.5", "0"
   */
  value: string;
}

/**
 * JSON сериализатор для SignedQuantity
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
 * Контракт:
 * - fromJSON НИКОГДА не доверяет типам, делает полную проверку
 * - toJSON ВСЕГДА возвращает валидный SignedQuantityJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { SignedQuantitySerializer } from '@polymarket/value-objects/signed-quantity';
 *
 * // Десериализация положительного
 * const result = SignedQuantitySerializer.fromJSON({ value: "10.5" });
 * if (result.ok) {
 *   console.log(result.value.toNumber()); // 10.5
 * }
 *
 * // Десериализация отрицательного
 * const result2 = SignedQuantitySerializer.fromJSON({ value: "-10.5" });
 * if (result2.ok) {
 *   console.log(result2.value.toNumber()); // -10.5
 * }
 *
 * // Сериализация
 * const qty = expectOk(SignedQuantityService.create(-10.5));
 * const json = SignedQuantitySerializer.toJSON(qty);
 * console.log(json); // { value: "-10.5" }
 * ```
 */
export class SignedQuantitySerializer {
  private static readonly SERVICE_NAME = 'SignedQuantitySerializer';

  /**
   * Сериализует SignedQuantity в JSON объект
   *
   * @param quantity - SignedQuantity для сериализации
   * @returns SignedQuantityJSON объект с value (string)
   *
   * @remarks
   * Возвращает строго типизированный SignedQuantityJSON.
   * Используем string для value чтобы сохранить точность.
   * Гарантирует что все поля присутствуют и имеют правильные типы.
   * Знак сохраняется в строке: "-10.5", "10.5", "0"
   *
   * @example
   * ```typescript
   * const positive = expectOk(SignedQuantityService.create(10.5));
   * const json1 = SignedQuantitySerializer.toJSON(positive);
   * console.log(json1); // { value: "10.5" }
   *
   * const negative = expectOk(SignedQuantityService.create(-10.5));
   * const json2 = SignedQuantitySerializer.toJSON(negative);
   * console.log(json2); // { value: "-10.5" }
   * ```
   */
  public static toJSON(quantity: SignedQuantity): SignedQuantityJSON {
    return { value: quantity.value().toString() };
  }

  /**
   * Десериализует SignedQuantity из JSON
   *
   * @remarks
   * Принимает unknown - граница валидации типов.
   * Валидирует структуру JSON перед парсингом.
   *
   * Этапы валидации:
   * 1. Проверка что json это объект (не null, array, primitive)
   * 2. Проверка наличия обязательного поля 'value'
   * 3. Проверка типа value (должен быть string)
   * 4. Делегирование SignedQuantityService.create для бизнес-валидации
   *
   * @param json - JSON данные (unknown)
   * @returns Result с SignedQuantity или InvalidSignedQuantityError
   *
   * @example
   * ```typescript
   * // ✅ Валидные примеры
   * SignedQuantitySerializer.fromJSON({ value: "10.5" });   // Ok (positive)
   * SignedQuantitySerializer.fromJSON({ value: "-10.5" });  // Ok (negative)
   * SignedQuantitySerializer.fromJSON({ value: "0" });      // Ok (zero)
   *
   * // ❌ Структурные ошибки
   * SignedQuantitySerializer.fromJSON(null);                // Err: expected object
   * SignedQuantitySerializer.fromJSON({ });                 // Err: missing field 'value'
   * SignedQuantitySerializer.fromJSON({ value: 10 });       // Err: value must be string
   *
   * // ❌ Бизнес-ошибки (делегированы SignedQuantityService)
   * SignedQuantitySerializer.fromJSON({ value: "NaN" });    // Err: invalid number
   * SignedQuantitySerializer.fromJSON({ value: "Infinity" }); // Err: not finite
   * ```
   */
  public static fromJSON(json: unknown): Result<SignedQuantity, InvalidSignedQuantityError> {
    // Форма разбирается общими гардами (shared/json), доменной остаётся
    // только ошибка: её тип и форма context закреплены потребителями
    const fail = (
      failure: JsonFailure,
    ): Result<SignedQuantity, InvalidSignedQuantityError> =>
      Err(
        new InvalidSignedQuantityError(jsonFailureMessage(failure, 'string'), {
          context: {
            source: ErrorSource.PARSING,
            service: SignedQuantitySerializer.SERVICE_NAME,
            op: 'fromJSON',
            kind: 'invalid_json',
            type: jsonFailureType(failure),
            json: safeStringify(json)
          }
        })
      );

    const obj = readJsonObject(json);
    if (!obj.ok) {
      return fail(obj.error);
    }

    // Только string, не number: знаковое количество хранится строкой ради точности
    const value = readField(obj.value, 'value', ['string']);
    if (!value.ok) {
      return fail(value.error);
    }

    // Делегируем создание SignedQuantityService
    return SignedQuantityService.create(value.value as string);
  }
}
