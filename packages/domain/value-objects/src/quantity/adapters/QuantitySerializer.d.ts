import { Result } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import { Quantity } from '../core/Quantity.js';
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
export declare class QuantitySerializer {
    private static readonly SERVICE_NAME;
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
    static toJSON(quantity: Quantity): QuantityJSON;
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
    static fromJSON(json: unknown): Result<Quantity, InvalidQuantityError>;
}
//# sourceMappingURL=QuantitySerializer.d.ts.map