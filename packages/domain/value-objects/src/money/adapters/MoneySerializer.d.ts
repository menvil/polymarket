import { Result } from '@polymarket/result';
import { InvalidMoneyError } from '@polymarket/errors';
import { Money } from '../core/Money.js';
/**
 * JSON контракт для Money сериализации
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
export interface MoneyJSON {
    /**
     * Amount as string для сохранения точности
     */
    amount: string;
    /**
     * Currency code (USDC, etc.)
     */
    currency: string;
}
/**
 * JSON сериализатор для Money
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
 * - toJSON ВСЕГДА возвращает валидный MoneyJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { MoneySerializer } from '@polymarket/value-objects/money';
 *
 * // Десериализация
 * const result = MoneySerializer.fromJSON({ amount: 100.50, currency: 'USDC' });
 * if (result.ok) {
 *   console.log(result.value.toNumber()); // 100.5
 * }
 *
 * // Сериализация
 * const money = Money.of(100.50);
 * const json = MoneySerializer.toJSON(money);
 * console.log(json); // { amount: "100.5", currency: "USDC" }
 * ```
 */
export declare class MoneySerializer {
    private static readonly SERVICE_NAME;
    /**
     * Десериализует Money из JSON
     *
     * @remarks
     * Принимает unknown - граница валидации типов.
     * Валидирует структуру JSON перед парсингом.
     *
     * Этапы валидации:
     * 1. Проверка что json это объект (не null, array, primitive)
     * 2. Проверка наличия обязательных полей 'amount' и 'currency'
     * 3. Проверка типов полей
     * 4. Делегирование MoneyService.create для бизнес-валидации
     *
     * @param json - JSON данные (unknown)
     * @returns Result с Money или InvalidMoneyError
     *
     * @example
     * ```typescript
     * // ✅ Валидные примеры
     * MoneySerializer.fromJSON({ amount: 100, currency: 'USDC' });
     * MoneySerializer.fromJSON({ amount: "100.50", currency: 'USDC' });
     *
     * // ❌ Невалидные примеры
     * MoneySerializer.fromJSON(null);                    // not an object
     * MoneySerializer.fromJSON({ amount: 100 });         // missing currency
     * MoneySerializer.fromJSON({ currency: 'USDC' });    // missing amount
     * MoneySerializer.fromJSON({ amount: null, currency: 'USDC' }); // invalid amount type
     * ```
     */
    static fromJSON(json: unknown): Result<Money, InvalidMoneyError>;
    /**
     * Сериализует Money в JSON объект
     *
     * @param money - Money для сериализации
     * @returns MoneyJSON объект с amount (string) и currency
     *
     * @remarks
     * Возвращает строго типизированный MoneyJSON.
     * Используем string для amount чтобы сохранить точность.
     * Гарантирует что все поля присутствуют и имеют правильные типы.
     *
     * @example
     * ```typescript
     * const money = Money.of(100.50);
     * const json = MoneySerializer.toJSON(money);
     * console.log(json); // { amount: "100.5", currency: "USDC" }
     *
     * // Можно сериализовать в JSON строку
     * const jsonString = JSON.stringify(json);
     * console.log(jsonString); // '{"amount":"100.5","currency":"USDC"}'
     * ```
     */
    static toJSON(money: Money): MoneyJSON;
}
//# sourceMappingURL=MoneySerializer.d.ts.map