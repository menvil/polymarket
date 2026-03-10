import { Result } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';
import { Price } from '../core/Price.js';
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
export declare class PriceSerializer {
    private static readonly SERVICE_NAME;
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
    static fromJSON(json: unknown): Result<Price, InvalidPriceError>;
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
    static toJSON(price: Price): PriceJSON;
}
//# sourceMappingURL=PriceSerializer.d.ts.map