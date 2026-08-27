import type { Result } from '@polymarket/result';
import type { InvalidOutcomePriceError } from '@polymarket/errors';
import type { OutcomePrice } from '../core/OutcomePrice.js';
import { priceFromJSON, priceToJSON } from '../../shared/price/priceCodec.js';
import { OUTCOME_PRICE_DOMAIN } from '../facade/OutcomePriceService.js';

/**
 * JSON контракт для OutcomePrice сериализации
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
export interface OutcomePriceJSON {
  /**
   * OutcomePrice value as string для сохранения точности
   */
  value: string;
}

/**
 * JSON сериализатор для OutcomePrice
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
 * - toJSON ВСЕГДА возвращает валидный OutcomePriceJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { OutcomePriceSerializer } from '@polymarket/value-objects/outcome-price';
 *
 * // Десериализация
 * const result = OutcomePriceSerializer.fromJSON({ value: 0.5 });
 * if (result.ok) {
 *   console.log(result.value.toNumber()); // 0.5
 * }
 *
 * // Сериализация
 * const price = expectOk(OutcomePriceService.create(0.5));
 * const json = OutcomePriceSerializer.toJSON(price);
 * console.log(json); // { value: "0.5" }
 * ```
 */
export class OutcomePriceSerializer {
  private static readonly SERVICE_NAME = 'OutcomePriceSerializer';
  /**
   * Десериализует OutcomePrice из JSON
   *
   * @remarks
   * Принимает unknown - граница валидации типов.
   * Валидирует структуру JSON перед парсингом.
   *
   * Этапы валидации:
   * 1. Проверка что json это объект (не null, array, primitive)
   * 2. Проверка наличия обязательного поля 'value'
   * 3. Проверка типа value (number или string)
   * 4. Делегирование OutcomePriceService.create для бизнес-валидации
   *
   * @param json - JSON данные (unknown)
   * @returns Result с OutcomePrice или InvalidOutcomePriceError
   *
   * @example
   * ```typescript
   * // ✅ Валидные примеры
   * OutcomePriceSerializer.fromJSON({ value: 0.5 });    // Ok
   * OutcomePriceSerializer.fromJSON({ value: "0.5" });  // Ok
   *
   * // ❌ Структурные ошибки
   * OutcomePriceSerializer.fromJSON(null);              // Err: expected object
   * OutcomePriceSerializer.fromJSON({ });               // Err: missing field 'value'
   * OutcomePriceSerializer.fromJSON({ value: {} });     // Err: wrong type
   *
   * // ❌ Бизнес-ошибки (делегированы OutcomePriceService)
   * OutcomePriceSerializer.fromJSON({ value: 1.5 });    // Err: exceeds maximum
   * ```
   */
  public static fromJSON(json: unknown): Result<OutcomePrice, InvalidOutcomePriceError> {
    return priceFromJSON(OUTCOME_PRICE_DOMAIN, json, OutcomePriceSerializer.SERVICE_NAME);
  }

  /**
   * Сериализует OutcomePrice в JSON объект
   *
   * @param price - OutcomePrice для сериализации
   * @returns OutcomePriceJSON объект с value (string)
   *
   * @remarks
   * Возвращает строго типизированный OutcomePriceJSON.
   * Используем string для value чтобы сохранить точность.
   * Гарантирует что все поля присутствуют и имеют правильные типы.
   *
   * @example
   * ```typescript
   * const price = expectOk(OutcomePriceService.create(0.5));
   * const json = OutcomePriceSerializer.toJSON(price);
   * console.log(json); // { value: "0.5" }
   * ```
   */
  public static toJSON(price: OutcomePrice): OutcomePriceJSON {
    return priceToJSON(price);
  }
}
