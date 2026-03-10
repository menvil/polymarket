import { Result } from '@polymarket/result';
import type { AccountId, VenueId } from '@polymarket/ids';
import { OutcomeToken } from '../../outcome-token/core/index.js';
import { Quantity } from '../../quantity/core/index.js';
import { TokenBalance } from '../core/index.js';
import { InvalidTokenBalanceError } from '../errors/index.js';
/**
 * Фасад для работы с TokenBalance - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с балансами токенов.
 * Оркестрирует Core + Rules для безопасных операций.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы TokenBalanceService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из Core инвариантов или Rules ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.available/reserved/qty - входные параметры (если применимо)
 * - context.reason - типизированная причина из TokenBalanceErrorReason enum (root, не перетирается)
 * - context.token - информация о токене
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidTokenBalanceError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 *
 * **Immutability:**
 * Все операции (reserve, unfreezeReserved, consumeReserved, updateAvailable) возвращают НОВЫЙ экземпляр TokenBalance.
 * Исходный баланс никогда не модифицируется.
 *
 * @example
 * ```typescript
 * import { TokenBalanceService } from '@polymarket/value-objects/token-balance';
 * import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
 * import { QuantityService } from '@polymarket/value-objects/quantity';
 * import { BinaryOutcome, KnownVenues, accountIdFromWallet, parseWalletAddress } from '@polymarket/ids';
 *
 * const token = expectOk(OutcomeTokenService.create(conditionRef, BinaryOutcome.UP));
 * const available = expectOk(QuantityService.create(100));
 * const reserved = expectOk(QuantityService.create(20));
 * const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
 * const accountId = accountIdFromWallet(walletAddress);
 *
 * // Создание баланса
 * const balanceResult = TokenBalanceService.create(token, available, reserved, accountId, KnownVenues.POLYMARKET);
 * if (balanceResult.ok) {
 *   const balance = balanceResult.value;
 *   console.log(balance.available().toNumber()); // 100
 *   console.log(balance.reserved().toNumber()); // 20
 *   console.log(balance.total().toNumber()); // 120
 * }
 *
 * // Резервирование токенов для ордера
 * const reserveResult = TokenBalanceService.reserve(balance, Quantity.of(new Decimal(30)));
 * if (reserveResult.ok) {
 *   console.log(reserveResult.value.available().toNumber()); // 70
 *   console.log(reserveResult.value.reserved().toNumber()); // 50
 * }
 * ```
 */
export declare class TokenBalanceService {
    private static readonly SERVICE_NAME;
    /**
     * Создаёт TokenBalance из OutcomeToken, available, reserved, AccountId и VenueId
     *
     * @param token - Outcome token
     * @param available - Количество доступных токенов (>= 0, finite, not NaN)
     * @param reserved - Количество зарезервированных токенов (>= 0, finite, not NaN)
     * @param accountId - ID аккаунта владельца баланса
     * @param venueId - ID площадки (venue) где находится баланс
     * @returns Result<TokenBalance, InvalidTokenBalanceError>
     * @throws Никогда - все ошибки оборачиваются в Result
     *
     * @remarks
     * ПУБЛИЧНЫЙ способ создания TokenBalance.
     * Возвращает Result вместо исключений.
     *
     * Процесс:
     * 1. Вызывает TokenBalance.of() для создания (проверит инварианты)
     * 2. Ловит TokenBalanceInvariantViolation и мапит в InvalidTokenBalanceError
     *
     * Проверяемые инварианты (в TokenBalance.of):
     * - token валиден
     * - available >= 0, finite, not NaN
     * - reserved >= 0, finite, not NaN
     * - accountId валиден
     * - venueId валиден
     *
     * @example
     * ```typescript
     * import { accountIdFromWallet, parseWalletAddress, KnownVenues } from '@polymarket/ids';
     *
     * const token = expectOk(OutcomeTokenService.create(conditionRef, BinaryOutcome.UP));
     * const available = Quantity.of(new Decimal(100));
     * const reserved = Quantity.of(new Decimal(20));
     * const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
     * const accountId = accountIdFromWallet(walletAddress);
     *
     * const result = TokenBalanceService.create(token, available, reserved, accountId, KnownVenues.POLYMARKET);
     * if (result.ok) {
     *   console.log(result.value.available().toNumber()); // 100
     *   console.log(result.value.reserved().toNumber()); // 20
     * } else {
     *   console.error(result.error.context?.reason);
     *   // TokenBalanceErrorReason.NEGATIVE_AVAILABLE
     *   // TokenBalanceErrorReason.NEGATIVE_RESERVED
     *   // TokenBalanceErrorReason.NAN
     *   // TokenBalanceErrorReason.NON_FINITE
     * }
     * ```
     */
    static create(token: OutcomeToken, available: Quantity, reserved: Quantity, accountId: AccountId, venueId: VenueId): Result<TokenBalance, InvalidTokenBalanceError>;
    /**
     * Создаёт TokenBalance с нулевым reserved
     *
     * @param token - Outcome token
     * @param available - Количество доступных токенов
     * @param accountId - ID аккаунта владельца
     * @param venueId - ID площадки (venue)
     * @returns Result<TokenBalance, InvalidTokenBalanceError>
     * @throws Никогда - все ошибки оборачиваются в Result
     *
     * @remarks
     * Convenience метод для создания баланса без зарезервированных токенов.
     * Используется при первичной загрузке баланса с blockchain.
     *
     * @example
     * ```typescript
     * const result = TokenBalanceService.createWithZeroReserved(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   accountId,
     *   venueId
     * );
     * if (result.ok) {
     *   console.log(result.value.available().toNumber()); // 100
     *   console.log(result.value.reserved().toNumber()); // 0
     *   console.log(result.value.total().toNumber()); // 100
     * }
     * ```
     */
    static createWithZeroReserved(token: OutcomeToken, available: Quantity, accountId: AccountId, venueId: VenueId): Result<TokenBalance, InvalidTokenBalanceError>;
    /**
     * Резервирует токены из available
     *
     * @param balance - Текущий баланс
     * @param qty - Количество для резервирования
     * @returns Result с новым TokenBalance или InvalidTokenBalanceError
     * @throws Никогда - все ошибки оборачиваются в Result
     *
     * @remarks
     * Создаёт НОВЫЙ TokenBalance с:
     * - available = balance.available - qty
     * - reserved = balance.reserved + qty
     *
     * **Use cases:**
     * - Создание ордера (резервирование токенов)
     * - Блокировка токенов для будущей операции
     *
     * Процесс:
     * 1. Проверяет достаточность available через ValidateReserveAmount
     * 2. Вычисляет новые available и reserved через QuantityService
     * 3. Создаёт новый TokenBalance через create()
     *
     * Обработка ошибок:
     * - Insufficient available → InvalidTokenBalanceError(INSUFFICIENT_AVAILABLE)
     * - Invariant fail → InvalidTokenBalanceError с reason
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * // Резервируем 30 токенов для ордера
     * const result = TokenBalanceService.reserve(balance, Quantity.of(new Decimal(30)));
     * if (result.ok) {
     *   console.log(result.value.available().toNumber()); // 70
     *   console.log(result.value.reserved().toNumber()); // 50
     * } else {
     *   console.error(result.error.context.reason);
     *   // TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE
     * }
     * ```
     */
    static reserve(balance: TokenBalance, qty: Quantity): Result<TokenBalance, InvalidTokenBalanceError>;
    /**
     * Размораживает зарезервированные токены (возврат в available)
     *
     * @param balance - Текущий баланс
     * @param qty - Количество для разморозки
     * @returns Result с новым TokenBalance или InvalidTokenBalanceError
     * @throws Никогда - все ошибки оборачиваются в Result
     *
     * @remarks
     * Создаёт НОВЫЙ TokenBalance с:
     * - available = balance.available + qty
     * - reserved = balance.reserved - qty
     *
     * **Use cases:**
     * - Отмена ордера (возврат зарезервированных токенов)
     * - Частичное исполнение (возврат неиспользованного остатка)
     * - Истечение срока резервирования
     *
     * **Важно:** Для списания reserved БЕЗ возврата в available используйте consumeReserved().
     *
     * Процесс:
     * 1. Проверяет достаточность reserved через ValidateReleaseAmount
     * 2. Вычисляет новые available и reserved через QuantityService
     * 3. Создаёт новый TokenBalance через create()
     *
     * Обработка ошибок:
     * - Insufficient reserved → InvalidTokenBalanceError(INSUFFICIENT_RESERVED)
     * - Invariant fail → InvalidTokenBalanceError с reason
     *
     * @example
     * ```typescript
     * // Отмена ордера - возвращаем зарезервированные токены
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(70)),
     *   Quantity.of(new Decimal(50)),
     *   accountId,
     *   venueId
     * ));
     *
     * const result = TokenBalanceService.unfreezeReserved(balance, Quantity.of(new Decimal(20)));
     * if (result.ok) {
     *   console.log(result.value.available().toNumber()); // 90 (было 70)
     *   console.log(result.value.reserved().toNumber()); // 30 (было 50)
     * } else {
     *   console.error(result.error.context.reason);
     *   // TokenBalanceErrorReason.INSUFFICIENT_RESERVED
     * }
     * ```
     */
    static unfreezeReserved(balance: TokenBalance, qty: Quantity): Result<TokenBalance, InvalidTokenBalanceError>;
    /**
     * Списывает зарезервированные токены (исполнение ордера)
     *
     * @param balance - Текущий баланс
     * @param qty - Количество для списания
     * @returns Result с новым TokenBalance или InvalidTokenBalanceError
     * @throws Никогда - все ошибки оборачиваются в Result
     *
     * @remarks
     * Создаёт НОВЫЙ TokenBalance с:
     * - available не меняется
     * - reserved = balance.reserved - qty
     *
     * **Use cases:**
     * - Исполнение ордера (списание зарезервированных токенов)
     * - Комиссия за операцию (списание из reserved)
     * - Любое списание БЕЗ возврата в available
     *
     * **Важно:** Это списание БЕЗ возврата в available.
     * Если нужно вернуть токены в available - используйте unfreezeReserved().
     *
     * **Если исполнилось меньше запланированного:**
     * ```typescript
     * // Зарезервировали 100, исполнилось только 80
     * consumeReserved(balance, Quantity.of(new Decimal(80)));  // списываем фактическое
     * unfreezeReserved(balance, Quantity.of(new Decimal(20))); // размораживаем остаток
     * ```
     *
     * Процесс:
     * 1. Проверяет достаточность reserved через ValidateReleaseAmount
     * 2. Вычисляет новый reserved через QuantityService
     * 3. Создаёт новый TokenBalance через create()
     *
     * Обработка ошибок:
     * - Insufficient reserved → InvalidTokenBalanceError(INSUFFICIENT_RESERVED)
     * - Invariant fail → InvalidTokenBalanceError с reason
     *
     * @example
     * ```typescript
     * // Исполнение ордера - списываем из reserved
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(70)),
     *   Quantity.of(new Decimal(50)),
     *   accountId,
     *   venueId
     * ));
     *
     * const result = TokenBalanceService.consumeReserved(balance, Quantity.of(new Decimal(20)));
     * if (result.ok) {
     *   console.log(result.value.available().toNumber()); // 70 (не изменилось!)
     *   console.log(result.value.reserved().toNumber()); // 30 (было 50)
     * } else {
     *   console.error(result.error.context.reason);
     *   // TokenBalanceErrorReason.INSUFFICIENT_RESERVED
     * }
     * ```
     */
    static consumeReserved(balance: TokenBalance, qty: Quantity): Result<TokenBalance, InvalidTokenBalanceError>;
    /**
     * Обновляет available токены (синхронизация с blockchain)
     *
     * @param balance - Текущий баланс
     * @param newAvailable - Новое количество available токенов
     * @returns Result с новым TokenBalance или InvalidTokenBalanceError
     * @throws Никогда - все ошибки оборачиваются в Result
     *
     * @remarks
     * Создаёт НОВЫЙ TokenBalance с:
     * - available = newAvailable
     * - reserved не меняется
     *
     * **Use cases:**
     * - Обновление баланса после синхронизации с blockchain
     * - Применение внешних изменений (deposit/withdraw)
     *
     * **Важно:** НЕ затрагивает reserved - только available.
     *
     * Процесс:
     * 1. Создаёт новый TokenBalance с newAvailable
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * // После синхронизации с blockchain available изменился на 150
     * const result = TokenBalanceService.updateAvailable(balance, Quantity.of(new Decimal(150)));
     * if (result.ok) {
     *   console.log(result.value.available().toNumber()); // 150
     *   console.log(result.value.reserved().toNumber()); // 20 (не изменилось)
     * }
     * ```
     */
    static updateAvailable(balance: TokenBalance, newAvailable: Quantity): Result<TokenBalance, InvalidTokenBalanceError>;
    /**
     * Проверяет возможность резервирования токенов
     *
     * @param balance - TokenBalance для проверки
     * @param qty - Количество для резервирования
     * @returns true если available >= qty, false в остальных случаях
     *
     * @remarks
     * Never throws - безопасная утилита для проверки.
     * Полезно для предварительной проверки перед резервированием.
     *
     * **Безопасность:**
     * - Если balance null/undefined - возвращает false
     * - Если qty null/undefined - возвращает false
     * - Перехватывает любые исключения и возвращает false
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     *
     * const canReserve30 = TokenBalanceService.canReserve(balance, Quantity.of(new Decimal(30))); // true
     * const canReserve200 = TokenBalanceService.canReserve(balance, Quantity.of(new Decimal(200))); // false
     *
     * if (canReserve30) {
     *   const result = TokenBalanceService.reserve(balance, Quantity.of(new Decimal(30)));
     *   // гарантированно успешно (если баланс не изменился между проверкой и резервированием)
     * }
     * ```
     */
    static canReserve(balance: TokenBalance, qty: Quantity): boolean;
    /**
     * Private helper: Сложение Quantity
     *
     * @remarks
     * Defensive programming: эта ветка ошибки практически недостижима,
     * так как Rules валидация гарантирует валидные входы для QuantityService.
     * Но оставляем для будущих изменений и полноты обработки ошибок.
     */
    private static addQuantity;
    /**
     * Private helper: Вычитание Quantity
     *
     * @remarks
     * Defensive programming: эта ветка ошибки практически недостижима,
     * так как Rules валидация гарантирует валидные входы для QuantityService.
     * Но оставляем для будущих изменений и полноты обработки ошибок.
     */
    private static subtractQuantity;
    /**
     * Сравнить два TokenBalance на равенство
     *
     * @param a - Первый TokenBalance
     * @param b - Второй TokenBalance
     * @returns true если балансы представляют одинаковый токен и количество, false в остальных случаях
     *
     * @remarks
     * Never throws - безопасная утилита для сравнения.
     * Использует метод equals() из TokenBalance core.
     *
     * **Безопасность:**
     * - Если любой из аргументов null/undefined - возвращает false
     * - Если любой из аргументов не является TokenBalance instance - возвращает false
     * - Перехватывает любые исключения и возвращает false
     *
     * @example
     * ```typescript
     * const balance1 = expectOk(TokenBalanceService.create(token, available1, reserved1, accountId, venueId));
     * const balance2 = expectOk(TokenBalanceService.create(token, available2, reserved2, accountId, venueId));
     *
     * const same = TokenBalanceService.equals(balance1, balance2);
     * console.log(same); // → true if available and reserved equal
     *
     * // Безопасно работает с невалидными входами
     * TokenBalanceService.equals(null, balance1); // → false (не бросает)
     * ```
     */
    static equals(a: TokenBalance, b: TokenBalance): boolean;
    /**
     * Проверяет что баланс нулевой (total = 0)
     *
     * @param balance - TokenBalance для проверки
     * @returns true если total (available + reserved) равно 0, false в остальных случаях
     *
     * @remarks
     * Never throws - безопасная утилита для проверки.
     * Делегирует к balance.isZero().
     *
     * **Безопасность:**
     * - Если balance null/undefined - возвращает false
     * - Если balance не является TokenBalance instance - возвращает false
     * - Перехватывает любые исключения и возвращает false
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.createWithZeroReserved(
     *   token,
     *   Quantity.ZERO,
     *   accountId,
     *   venueId
     * ));
     * const isZero = TokenBalanceService.isZero(balance); // true
     *
     * // С reserved > 0 не будет zero
     * const withReserved = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.ZERO,
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     * TokenBalanceService.isZero(withReserved); // false
     *
     * // Безопасно работает с невалидными входами
     * TokenBalanceService.isZero(null); // → false (не бросает)
     * ```
     */
    static isZero(balance: TokenBalance): boolean;
    /**
     * Проверяет что баланс положительный (total > 0)
     *
     * @param balance - TokenBalance для проверки
     * @returns true если total (available + reserved) > 0, false в остальных случаях
     *
     * @remarks
     * Never throws - безопасная утилита для проверки.
     * Делегирует к balance.isPositive().
     *
     * **Безопасность:**
     * - Если balance null/undefined - возвращает false
     * - Если balance не является TokenBalance instance - возвращает false
     * - Перехватывает любые исключения и возвращает false
     *
     * @example
     * ```typescript
     * const balance = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.of(new Decimal(100)),
     *   Quantity.ZERO,
     *   accountId,
     *   venueId
     * ));
     * const isPositive = TokenBalanceService.isPositive(balance); // true
     *
     * // Даже с нулевым available, но ненулевым reserved будет positive
     * const withReservedOnly = expectOk(TokenBalanceService.create(
     *   token,
     *   Quantity.ZERO,
     *   Quantity.of(new Decimal(20)),
     *   accountId,
     *   venueId
     * ));
     * TokenBalanceService.isPositive(withReservedOnly); // true
     *
     * // Безопасно работает с невалидными входами
     * TokenBalanceService.isPositive(null); // → false (не бросает)
     * ```
     */
    static isPositive(balance: TokenBalance): boolean;
}
//# sourceMappingURL=TokenBalanceService.d.ts.map