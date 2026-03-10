import { Result } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import { Balance } from '../core/Balance.js';
/**
 * JSON контракт для Balance сериализации
 *
 * @remarks
 * Используется как:
 * - Контракт API (документация структуры)
 * - Return type для toJSON()
 * - Type hint при создании JSON
 *
 * При парсинге (fromJSON) НЕ полагайся на этот тип -
 * делай полную runtime валидацию с unknown!
 *
 * Использует string для amount чтобы сохранить точность Decimal.
 *
 * @example
 * ```json
 * {
 *   "available": { "amount": "10000", "currency": "USDC" },
 *   "reserved": { "amount": "2000", "currency": "USDC" },
 *   "accountId": "wallet:0x1234567890123456789012345678901234567890",
 *   "venueId": "POLYMARKET"
 * }
 * ```
 */
export interface BalanceJSON {
    available: {
        amount: string;
        currency: string;
    };
    reserved: {
        amount: string;
        currency: string;
    };
    accountId: string;
    venueId: string;
}
/**
 * JSON сериализатор для Balance
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
 * - toJSON ВСЕГДА возвращает валидный BalanceJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * **Формат JSON:**
 * ```json
 * {
 *   "available": { "amount": "10000", "currency": "USDC" },
 *   "reserved": { "amount": "2000", "currency": "USDC" },
 *   "accountId": "wallet:0x1234567890123456789012345678901234567890",
 *   "venueId": "POLYMARKET"
 * }
 * ```
 *
 * @example
 * ```typescript
 * import { BalanceSerializer } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 * import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';
 *
 * // Десериализация
 * const result = BalanceSerializer.fromJSON({
 *   available: { amount: "10000", currency: "USDC" },
 *   reserved: { amount: "2000", currency: "USDC" },
 *   accountId: "wallet:0x1234567890123456789012345678901234567890",
 *   venueId: "POLYMARKET"
 * });
 * if (result.ok) {
 *   console.log(result.value.total().value()); // 12000
 * }
 *
 * // Сериализация
 * const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
 * const venueId: VenueId = 'POLYMARKET' as VenueId;
 *
 * const balance = expectOk(BalanceService.create(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000),
 *   accountId,
 *   venueId
 * ));
 * const json = BalanceSerializer.toJSON(balance);
 * console.log(json);
 * // {
 * //   available: { amount: "10000", currency: "USDC" },
 * //   reserved: { amount: "2000", currency: "USDC" },
 * //   accountId: "wallet:0x...",
 * //   venueId: "POLYMARKET"
 * // }
 * ```
 */
export declare class BalanceSerializer {
    private static readonly SERVICE_NAME;
    /**
     * Десериализует Balance из JSON
     *
     * @remarks
     * Принимает unknown - граница валидации типов.
     * Валидирует структуру JSON перед парсингом.
     *
     * Этапы валидации:
     * 1. Проверка что json это объект (не null, array, primitive)
     * 2. Проверка наличия обязательных полей 'available' и 'reserved'
     * 3. Проверка типов полей available/reserved (должны быть объектами)
     * 4. Десериализация available через MoneySerializer
     * 5. Десериализация reserved через MoneySerializer
     * 6. Проверка наличия обязательных полей 'accountId' и 'venueId'
     * 7. Проверка типов полей accountId/venueId (должны быть строками)
     * 8. Парсинг accountId через parseAccountId()
     * 9. Создание VenueId (branded string)
     * 10. Делегирование BalanceService.create для бизнес-валидации
     *
     * @param json - JSON данные (unknown)
     * @returns Result с Balance или InvalidBalanceError
     *
     * @example
     * ```typescript
     * // ✅ Валидные примеры
     * BalanceSerializer.fromJSON({
     *   available: { amount: "10000", currency: "USDC" },
     *   reserved: { amount: "2000", currency: "USDC" },
     *   accountId: "wallet:0x1234567890123456789012345678901234567890",
     *   venueId: "POLYMARKET"
     * });
     *
     * // ❌ Структурные ошибки
     * BalanceSerializer.fromJSON(null);                    // Err: expected object
     * BalanceSerializer.fromJSON({ available: ... });      // Err: missing 'reserved'
     * BalanceSerializer.fromJSON({
     *   available: ...,
     *   reserved: ...
     * });  // Err: missing 'accountId'
     *
     * // ❌ Бизнес-ошибки (делегированы BalanceService)
     * BalanceSerializer.fromJSON({
     *   available: { amount: "-100", currency: "USDC" },  // Err: negative available
     *   reserved: { amount: "0", currency: "USDC" },
     *   accountId: "wallet:0x...",
     *   venueId: "POLYMARKET"
     * });
     * ```
     */
    static fromJSON(json: unknown): Result<Balance, InvalidBalanceError>;
    /**
     * Сериализует Balance в JSON
     *
     * @remarks
     * Возвращает plain object с полями available, reserved, accountId и venueId.
     * Каждое поле available/reserved содержит { amount: string, currency: string }.
     * Используем string для amount чтобы избежать потери точности.
     * accountId сериализуется через accountIdToString() в canonical format.
     * venueId сериализуется как string (branded VenueId).
     *
     * @param balance - Balance для сериализации
     * @returns Plain object { available: {...}, reserved: {...}, accountId: string, venueId: string }
     *
     * @example
     * ```typescript
     * const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
     * const venueId: VenueId = 'POLYMARKET' as VenueId;
     *
     * const balance = expectOk(BalanceService.create(
     *   Money.fromUSDC(10000),
     *   Money.fromUSDC(2000),
     *   accountId,
     *   venueId
     * ));
     *
     * const json = BalanceSerializer.toJSON(balance);
     * console.log(json);
     * // {
     * //   available: { amount: "10000", currency: "USDC" },
     * //   reserved: { amount: "2000", currency: "USDC" },
     * //   accountId: "wallet:0x...",
     * //   venueId: "POLYMARKET"
     * // }
     *
     * // Можно сериализовать в JSON строку
     * const jsonString = JSON.stringify(json);
     * ```
     */
    static toJSON(balance: Balance): BalanceJSON;
}
//# sourceMappingURL=BalanceSerializer.d.ts.map