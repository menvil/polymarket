import Decimal from 'decimal.js';
import type { AssetId, OnChainConditionRef, OutcomeKey, AccountId, VenueId } from '@polymarket/ids';
import { OutcomeToken } from '../../outcome-token/core/OutcomeToken.js';
import { Quantity } from '../../quantity/core/Quantity.js';
/**
 * Core TokenBalance Value Object - баланс токенов с разделением на available/reserved
 *
 * @remarks
 * Представляет баланс outcome token на кошельке/venue конкретного пользователя
 * с разделением на доступные и зарезервированные токены.
 *
 * **Модель available/reserved:**
 * - **available** - доступные для использования токены (можно резервировать для ордеров)
 * - **reserved** - зарезервированные токены (заблокированы в открытых ордерах)
 * - **total** - derived value (available + reserved)
 *
 * **Use cases:**
 * - При создании ордера: резервирование токенов (available → reserved)
 * - При отмене ордера: разморозка токенов (reserved → available)
 * - При исполнении ордера: списание зарезервированных (reserved--)
 *
 * **Отличие от AssetQuantity:**
 * - **TokenBalance**: Баланс outcome token конкретного аккаунта на конкретном venue (account-specific)
 * - **AssetQuantity**: Generic количество любого актива БЕЗ привязки к владельцу (account-agnostic)
 *
 * **Иммутабельность:**
 * - Все поля readonly
 * - Не предоставляет методов изменения
 * - Для изменений создавайте новый TokenBalance через TokenBalanceService
 *
 * **Инварианты (проверяются в constructor):**
 * - token должен быть валидным OutcomeToken
 * - available должен быть валидным Quantity (>= 0, finite, not NaN)
 * - reserved должен быть валидным Quantity (>= 0, finite, not NaN)
 * - accountId должен быть валидным AccountId
 * - venueId должен быть валидным VenueId
 *
 * **Core не использует Result:**
 * Если нарушены инварианты — бросает TokenBalanceInvariantViolation.
 * Facade перехватывает и конвертирует в Result.Err.
 *
 * **Математика:**
 * TokenBalance НЕ содержит математических операций.
 * Используй TokenBalanceService для reserve/unfreeze/consume и т.д.
 *
 * @example
 * ```typescript
 * // ✅ В Core/Facade layer
 * import { accountIdFromWallet, KnownVenues } from '@polymarket/ids';
 *
 * const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
 * const available = Quantity.of(new Decimal(100));
 * const reserved = Quantity.of(new Decimal(20));
 * const accountId = accountIdFromWallet('0x1234...').unwrap();
 * const balance = TokenBalance.of(token, available, reserved, accountId, KnownVenues.POLYMARKET);
 *
 * // ❌ В публичном коде - используй TokenBalanceService
 * const result = TokenBalanceService.create(token, available, reserved, accountId, venueId);
 * if (result.ok) {
 *   const balance = result.value;
 *   console.log(balance.available().toNumber()); // 100
 *   console.log(balance.reserved().toNumber()); // 20
 *   console.log(balance.total().toNumber()); // 120
 *   console.log(balance.venueId()); // 'POLYMARKET'
 * }
 * ```
 */
export declare class TokenBalance {
    private readonly _token;
    private readonly _available;
    private readonly _reserved;
    private readonly _accountId;
    private readonly _venueId;
    private constructor();
    /**
     * Создаёт TokenBalance из OutcomeToken, available, reserved, AccountId и VenueId
     *
     * @internal ТОЛЬКО для внутреннего использования в Core и Facade
     *
     * @remarks
     * Валидация инвариантов выполняется в constructor.
     * Проверяет что объекты существуют и являются правильными типами.
     *
     * Для публичного API используйте TokenBalanceService.create().
     *
     * @param token - Outcome token
     * @param available - Количество доступных токенов (>= 0, finite, not NaN)
     * @param reserved - Количество зарезервированных токенов (>= 0, finite, not NaN)
     * @param accountId - ID аккаунта владельца баланса
     * @param venueId - ID площадки (venue) где находится баланс
     * @returns Новый TokenBalance
     * @throws {TokenBalanceInvariantViolation} Если инварианты нарушены
     *
     * @example
     * ```typescript
     * // ✅ В Core/Facade
     * import { accountIdFromWallet, parseWalletAddress, KnownVenues } from '@polymarket/ids';
     *
     * const token = OutcomeToken.of(conditionRef, outcomeKey);
     * const available = Quantity.of(new Decimal(100));
     * const reserved = Quantity.of(new Decimal(20));
     * const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
     * const accountId = accountIdFromWallet(walletAddress);
     * const balance = TokenBalance.of(token, available, reserved, accountId, KnownVenues.POLYMARKET);
     *
     * // ❌ В публичном коде - используй TokenBalanceService
     * const result = TokenBalanceService.create(token, available, reserved, accountId, venueId);
     * ```
     */
    static of(token: OutcomeToken, available: Quantity, reserved: Quantity, accountId: AccountId, venueId: VenueId): TokenBalance;
    /**
     * Создаёт TokenBalance с нулевым reserved
     *
     * @param token - Outcome token
     * @param available - Количество доступных токенов
     * @param accountId - ID аккаунта владельца
     * @param venueId - ID площадки (venue)
     * @returns Новый TokenBalance с reserved = 0
     * @throws {TokenBalanceInvariantViolation} Если available < 0 или другие инварианты нарушены
     *
     * @remarks
     * Convenience метод для создания баланса без зарезервированных токенов.
     * Используется при первичной загрузке баланса с blockchain.
     *
     * **ВАЖНО:** Использует полную валидацию через of(), включая проверки на null/undefined
     * и instanceof. Не обходит валидацию в отличие от прямого вызова конструктора.
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.withZeroReserved(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   accountId,
     *   venueId
     * );
     * // available: 100, reserved: 0, total: 100
     * ```
     */
    static withZeroReserved(token: OutcomeToken, available: Quantity, accountId: AccountId, venueId: VenueId): TokenBalance;
    /**
     * Возвращает outcome token
     *
     * @returns OutcomeToken
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
     * const token = balance.token();
     * console.log(token.outcomeKey()); // 'UP'
     * ```
     */
    token(): OutcomeToken;
    /**
     * Возвращает доступные токены
     *
     * @returns Quantity с available amount
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
     * const avail = balance.available();
     * console.log(avail.toNumber()); // 100
     * ```
     */
    available(): Quantity;
    /**
     * Возвращает зарезервированные токены
     *
     * @returns Quantity с reserved amount
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
     * const res = balance.reserved();
     * console.log(res.toNumber()); // 20
     * ```
     */
    reserved(): Quantity;
    /**
     * Вычисляет общее количество токенов (available + reserved)
     *
     * @returns Quantity с total amount
     *
     * @remarks
     * Derived value - вычисляется каждый раз при вызове.
     *
     * Безопасно потому что:
     * - Оба значения >= 0 (инварианты TokenBalance)
     * - Оба значения finite и not NaN (инварианты TokenBalance)
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.of(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * );
     * console.log(balance.total().toNumber()); // 120
     * ```
     */
    total(): Quantity;
    /**
     * Возвращает ID аккаунта владельца баланса
     *
     * @returns AccountId
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
     * const accId = balance.accountId();
     * console.log(accId.kind); // 'WALLET' | 'VENUE' | 'SUBACCOUNT'
     * ```
     */
    accountId(): AccountId;
    /**
     * Возвращает ID площадки (venue) где находится баланс
     *
     * @returns VenueId
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
     * const venue = balance.venueId();
     * console.log(venue); // 'POLYMARKET'
     * ```
     */
    venueId(): VenueId;
    /**
     * Helper: возвращает AssetId токена
     *
     * @remarks
     * Делегирует к token().assetId() для удобства.
     *
     * @returns AssetId
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
     * const assetId = balance.assetId();
     * // Эквивалентно: balance.token().assetId()
     * ```
     */
    assetId(): AssetId;
    /**
     * Helper: возвращает ConditionRef токена
     *
     * @remarks
     * Делегирует к token().conditionRef() для удобства.
     *
     * @returns OnChainConditionRef
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
     * const ref = balance.conditionRef();
     * console.log(ref.protocolId); // 'POLYMARKET_CTF'
     * ```
     */
    conditionRef(): OnChainConditionRef;
    /**
     * Helper: возвращает OutcomeKey токена
     *
     * @remarks
     * Делегирует к token().outcomeKey() для удобства.
     *
     * @returns OutcomeKey
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.of(token, available, reserved, accountId, venueId);
     * const key = balance.outcomeKey();
     * console.log(key); // 'UP'
     * ```
     */
    outcomeKey(): OutcomeKey;
    /**
     * Проверяет, есть ли зарезервированные токены
     *
     * @returns true если reserved > 0
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.of(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * );
     * console.log(balance.hasReserved()); // true
     * ```
     */
    hasReserved(): boolean;
    /**
     * Вычисляет процент зарезервированных токенов от total
     *
     * @returns Decimal с процентами (0-100), или 0 если total = 0
     *
     * @remarks
     * Formula: (reserved / total) * 100
     * Если total = 0, возвращает 0 (избегаем деления на ноль).
     *
     * @example
     * ```typescript
     * const balance = TokenBalance.of(
     *   token,
     *   Quantity.of(new Decimal(80)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * );
     * console.log(balance.reservedPercentage().toFixed(2)); // "20.00"
     *
     * const empty = TokenBalance.withZeroReserved(token, Quantity.ZERO, accountId, venueId);
     * console.log(empty.reservedPercentage().toFixed(2)); // "0.00"
     * ```
     */
    reservedPercentage(): Decimal;
    /**
     * Проверяет совпадение токенов
     *
     * @param other - Другой TokenBalance для сравнения
     * @returns true если токены совпадают
     *
     * @remarks
     * Используется в TokenBalanceService для проверки совместимости операций.
     *
     * @example
     * ```typescript
     * const balance1 = TokenBalance.of(token, Quantity.of(new Decimal(100)), Quantity.ZERO, accountId, venueId);
     * const balance2 = TokenBalance.of(token, Quantity.of(new Decimal(200)), Quantity.ZERO, accountId, venueId);
     * console.log(balance1.hasSameToken(balance2)); // true
     * ```
     */
    hasSameToken(other: TokenBalance): boolean;
    /**
     * Проверяет равенство с другим TokenBalance
     *
     * @remarks
     * Два баланса равны если:
     * - Их токены равны (token.equals)
     * - Их available количества равны (available.equals)
     * - Их reserved количества равны (reserved.equals)
     * - Их аккаунты равны (accountIdEquals)
     * - Их venues равны (venueId === venueId)
     *
     * @param other - Другой TokenBalance для сравнения
     * @returns true если балансы представляют одинаковый токен, количества, аккаунт и venue
     *
     * @example
     * ```typescript
     * const balance1 = TokenBalance.of(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * );
     * const balance2 = TokenBalance.of(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * );
     * const balance3 = TokenBalance.of(
     *   token,
     *   Quantity.of(new Decimal(200)),
     *   Quantity.ZERO,
     *   accountId,
     *   venueId
     * );
     *
     * balance1.equals(balance2); // true
     * balance1.equals(balance3); // false (разные available/reserved)
     * ```
     */
    equals(other: TokenBalance): boolean;
    /**
     * Проверяет что баланс нулевой (total = 0)
     *
     * @remarks
     * Баланс нулевой если available = 0 AND reserved = 0.
     * Полезно для проверки пустых позиций.
     *
     * @returns true если available = 0 AND reserved = 0
     *
     * @example
     * ```typescript
     * const zeroBalance = TokenBalance.withZeroReserved(token, Quantity.ZERO, accountId, venueId);
     * const nonZeroBalance = TokenBalance.of(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.ZERO,
     *   accountId,
     *   venueId
     * );
     * const withReserved = TokenBalance.of(
     *   token,
     *   Quantity.ZERO,
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * );
     *
     * zeroBalance.isZero();    // true
     * nonZeroBalance.isZero(); // false
     * withReserved.isZero();   // false (reserved > 0)
     * ```
     */
    isZero(): boolean;
    /**
     * Проверяет что баланс положительный (total > 0)
     *
     * @remarks
     * Баланс положительный если total (available + reserved) > 0.
     * Полезно для проверки активных позиций.
     *
     * @returns true если total > 0
     *
     * @example
     * ```typescript
     * const zeroBalance = TokenBalance.withZeroReserved(token, Quantity.ZERO, accountId, venueId);
     * const positiveBalance = TokenBalance.of(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.ZERO,
     *   accountId,
     *   venueId
     * );
     * const withReserved = TokenBalance.of(
     *   token,
     *   Quantity.ZERO,
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * );
     *
     * zeroBalance.isPositive();    // false
     * positiveBalance.isPositive(); // true
     * withReserved.isPositive();   // true (reserved > 0)
     * ```
     */
    isPositive(): boolean;
}
//# sourceMappingURL=TokenBalance.d.ts.map