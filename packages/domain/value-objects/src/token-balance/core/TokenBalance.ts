import Decimal from 'decimal.js';
import type { AssetId, OnChainConditionRef, OutcomeKey, AccountId, VenueId } from '@polymarket/ids';
import { accountIdEquals } from '@polymarket/ids';
import { OutcomeToken } from '../../outcome-token/core/OutcomeToken.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { TokenBalanceInvariantViolation } from './TokenBalanceInvariantViolation.js';
import { TokenBalanceErrorReason } from '../errors/TokenBalanceErrorReason.js';

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
export class TokenBalance {
  private constructor(
    private readonly _token: OutcomeToken,
    private readonly _available: Quantity,
    private readonly _reserved: Quantity,
    private readonly _accountId: AccountId,
    private readonly _venueId: VenueId
  ) {
    // Инвариант 0a: Not NaN
    if (_available.value().isNaN() || _reserved.value().isNaN()) {
      throw new TokenBalanceInvariantViolation(
        'TokenBalance amounts cannot be NaN',
        TokenBalanceErrorReason.NAN
      );
    }

    // Инвариант 0b: Must be finite
    if (!_available.value().isFinite() || !_reserved.value().isFinite()) {
      throw new TokenBalanceInvariantViolation(
        'TokenBalance amounts must be finite',
        TokenBalanceErrorReason.NON_FINITE
      );
    }

    // Инвариант 1: available >= 0
    if (_available.value().isNegative()) {
      throw new TokenBalanceInvariantViolation(
        'Available amount cannot be negative',
        TokenBalanceErrorReason.NEGATIVE_AVAILABLE
      );
    }

    // Инвариант 2: reserved >= 0
    if (_reserved.value().isNegative()) {
      throw new TokenBalanceInvariantViolation(
        'Reserved amount cannot be negative',
        TokenBalanceErrorReason.NEGATIVE_RESERVED
      );
    }
  }

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
  public static of(
    token: OutcomeToken,
    available: Quantity,
    reserved: Quantity,
    accountId: AccountId,
    venueId: VenueId
  ): TokenBalance {
    // Минимальная валидация на null/undefined
    if (!token) {
      throw new TokenBalanceInvariantViolation(
        'TokenBalance.of: token is required',
        TokenBalanceErrorReason.INVALID_TOKEN
      );
    }

    // Валидация что token это действительно OutcomeToken (не просто объект)
    if (!(token instanceof OutcomeToken)) {
      throw new TokenBalanceInvariantViolation(
        'TokenBalance.of: token must be OutcomeToken instance',
        TokenBalanceErrorReason.INVALID_TOKEN
      );
    }

    if (!available) {
      throw new TokenBalanceInvariantViolation(
        'TokenBalance.of: available is required',
        TokenBalanceErrorReason.INVALID_AMOUNT
      );
    }

    // Валидация что available это действительно Quantity (не просто объект)
    if (!(available instanceof Quantity)) {
      throw new TokenBalanceInvariantViolation(
        'TokenBalance.of: available must be Quantity instance',
        TokenBalanceErrorReason.INVALID_AMOUNT
      );
    }

    if (!reserved) {
      throw new TokenBalanceInvariantViolation(
        'TokenBalance.of: reserved is required',
        TokenBalanceErrorReason.INVALID_AMOUNT
      );
    }

    // Валидация что reserved это действительно Quantity (не просто объект)
    if (!(reserved instanceof Quantity)) {
      throw new TokenBalanceInvariantViolation(
        'TokenBalance.of: reserved must be Quantity instance',
        TokenBalanceErrorReason.INVALID_AMOUNT
      );
    }

    if (!accountId) {
      throw new TokenBalanceInvariantViolation(
        'TokenBalance.of: accountId is required',
        TokenBalanceErrorReason.INVALID_FORMAT
      );
    }

    if (!venueId) {
      throw new TokenBalanceInvariantViolation(
        'TokenBalance.of: venueId is required',
        TokenBalanceErrorReason.INVALID_FORMAT
      );
    }

    // Инварианты проверяются в constructor
    return new TokenBalance(token, available, reserved, accountId, venueId);
  }

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
  public static withZeroReserved(
    token: OutcomeToken,
    available: Quantity,
    accountId: AccountId,
    venueId: VenueId
  ): TokenBalance {
    // Делегируем к of() для полной валидации (не bypass конструктор!)
    return TokenBalance.of(token, available, Quantity.ZERO, accountId, venueId);
  }

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
  public token(): OutcomeToken {
    return this._token;
  }

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
  public available(): Quantity {
    return this._available;
  }

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
  public reserved(): Quantity {
    return this._reserved;
  }

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
  public total(): Quantity {
    // Прямое вычисление через Decimal (не нужен QuantityService)
    const totalDecimal = this._available.value().plus(this._reserved.value());

    // Создаём Quantity из результата
    // Безопасно благодаря инвариантам TokenBalance
    return Quantity.of(totalDecimal);
  }

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
  public accountId(): AccountId {
    return this._accountId;
  }

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
  public venueId(): VenueId {
    return this._venueId;
  }

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
  public assetId(): AssetId {
    return this._token.assetId();
  }

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
  public conditionRef(): OnChainConditionRef {
    return this._token.conditionRef();
  }

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
  public outcomeKey(): OutcomeKey {
    return this._token.outcomeKey();
  }

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
  public hasReserved(): boolean {
    return this._reserved.value().greaterThan(0);
  }

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
  public reservedPercentage(): Decimal {
    const totalAmount = this.total().value();
    if (totalAmount.equals(0)) {
      return new Decimal(0);
    }

    return this._reserved.value().dividedBy(totalAmount).times(100);
  }

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
  public hasSameToken(other: TokenBalance): boolean {
    if (!other) return false;
    return this._token.equals(other._token);
  }

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
  public equals(other: TokenBalance): boolean {
    if (!other || !(other instanceof TokenBalance)) return false;
    return (
      this._token.equals(other._token) &&
      this._available.equals(other._available) &&
      this._reserved.equals(other._reserved) &&
      accountIdEquals(this._accountId, other._accountId) &&
      this._venueId === other._venueId
    );
  }

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
  public isZero(): boolean {
    return this.total().value().equals(0);
  }

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
  public isPositive(): boolean {
    return this.total().value().greaterThan(0);
  }
}
