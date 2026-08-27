import { Result, Err } from '@polymarket/result';
import { InvalidQuantityError, ErrorSource } from '@polymarket/errors';
import { Quantity } from '../core/Quantity.js';
import { QuantityService } from '../facade/QuantityService.js';
import type { JsonFailure } from '../../shared/json/index.js';
import {
  jsonFailureMessage,
  jsonFailureType,
  readField,
  readJsonObject,
  safeStringify,
} from '../../shared/json/index.js';

/**
 * JSON контракт для Quantity сериализации
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
export interface QuantityJSON {
  /**
   * Quantity value as string для сохранения точности
   */
  value: string;
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
 * Контракт:
 * - fromJSON НИКОГДА не доверяет типам, делает полную проверку
 * - toJSON ВСЕГДА возвращает валидный QuantityJSON
 * - Все ошибки возвращаются через Result.Err
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
  private static readonly SERVICE_NAME = 'QuantitySerializer';
  /**
   * Сериализует Quantity в JSON объект
   *
   * @param quantity - Quantity для сериализации
   * @returns QuantityJSON объект с value (string)
   *
   * @remarks
   * Возвращает строго типизированный QuantityJSON.
   * Используем string для value чтобы сохранить точность.
   * Гарантирует что все поля присутствуют и имеют правильные типы.
   *
   * @example
   * ```typescript
   * const qty = expectOk(QuantityService.create(10.5));
   * const json = QuantitySerializer.toJSON(qty);
   * console.log(json); // { value: "10.5" }
   * ```
   */
  public static toJSON(quantity: Quantity): QuantityJSON {
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
    // Форма разбирается общими гардами (shared/json), доменной остаётся
    // только ошибка: её тип и форма context закреплены потребителями
    const fail = (failure: JsonFailure): Result<Quantity, InvalidQuantityError> =>
      Err(
        new InvalidQuantityError(jsonFailureMessage(failure, 'string'), {
          context: {
            source: ErrorSource.PARSING,
            service: QuantitySerializer.SERVICE_NAME,
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

    // Только string, не number: у количества точность важнее удобства
    const value = readField(obj.value, 'value', ['string']);
    if (!value.ok) {
      return fail(value.error);
    }

    // Делегируем создание QuantityService
    return QuantityService.create(value.value as string);
  }
}
