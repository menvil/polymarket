import { Err } from '@polymarket/result';
import { InvalidPriceError, ErrorSource } from '@polymarket/errors';
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
function safeStringify(value) {
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
    }
    catch {
        return '[Unstringifiable]';
    }
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
    static SERVICE_NAME = 'PriceSerializer';
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
    static fromJSON(json) {
        // Проверка что это объект
        if (typeof json !== 'object' || json === null) {
            return Err(new InvalidPriceError((ctx) => `Expected object, got ${ctx.type}`, {
                context: {
                    source: ErrorSource.PARSING,
                    service: PriceSerializer.SERVICE_NAME,
                    op: 'fromJSON',
                    kind: 'invalid_json',
                    type: typeof json,
                    json: safeStringify(json)
                }
            }));
        }
        // Проверка что это не массив
        if (Array.isArray(json)) {
            return Err(new InvalidPriceError(() => `Expected object, got array`, {
                context: {
                    source: ErrorSource.PARSING,
                    service: PriceSerializer.SERVICE_NAME,
                    op: 'fromJSON',
                    kind: 'invalid_json',
                    type: 'array',
                    json: safeStringify(json)
                }
            }));
        }
        // Проверка наличия поля value (own-property check — исключает prototype chain)
        if (!Object.hasOwn(json, 'value')) {
            return Err(new InvalidPriceError(() => `Missing required field 'value'`, {
                context: {
                    source: ErrorSource.PARSING,
                    service: PriceSerializer.SERVICE_NAME,
                    op: 'fromJSON',
                    kind: 'invalid_json',
                    type: 'missing_field',
                    json: safeStringify(json)
                }
            }));
        }
        const value = json.value;
        // Проверка типа value
        if (typeof value !== 'number' && typeof value !== 'string') {
            return Err(new InvalidPriceError((ctx) => `Field 'value' must be number or string, got ${ctx.type}`, {
                context: {
                    source: ErrorSource.PARSING,
                    service: PriceSerializer.SERVICE_NAME,
                    op: 'fromJSON',
                    kind: 'invalid_json',
                    type: typeof value,
                    json: safeStringify(json)
                }
            }));
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
    static toJSON(price) {
        return {
            value: price.value().toString()
        };
    }
}
//# sourceMappingURL=PriceSerializer.js.map