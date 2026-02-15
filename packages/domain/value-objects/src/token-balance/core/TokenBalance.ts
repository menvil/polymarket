import type { AssetId, OnChainConditionRef, OutcomeKey, AccountId, VenueId } from '@polymarket/ids';
import { accountIdEquals } from '@polymarket/ids';
import { OutcomeToken } from '../../outcome-token/core/OutcomeToken.js';
import { Quantity } from '../../quantity/core/Quantity.js';

/**
 * Core TokenBalance Value Object
 *
 * @remarks
 * Представляет баланс outcome token на кошельке/venue конкретного пользователя.
 * Сочетает информацию о токене (OutcomeToken), количестве (Quantity), владельце (AccountId) и площадке (VenueId).
 *
 * **Отличие от AssetQuantity:**
 * - **TokenBalance**: Баланс outcome token конкретного аккаунта на конкретном venue (account-specific)
 * - **AssetQuantity**: Generic количество любого актива БЕЗ привязки к владельцу (account-agnostic)
 *
 * **Иммутабельность:**
 * - Все поля readonly
 * - Не предоставляет методов изменения
 * - Для изменений создавайте новый TokenBalance
 *
 * **Инварианты:**
 * - token должен быть валидным OutcomeToken
 * - amount должен быть валидным Quantity (non-negative, finite)
 * - accountId должен быть валидным AccountId
 * - venueId должен быть валидным VenueId
 * - Нет дополнительных инвариантов (amount может быть 0)
 *
 * **Core не использует Result:**
 * Если нарушены инварианты — бросает TokenBalanceInvariantViolation.
 * Facade перехватывает и конвертирует в Result.Err.
 *
 * **Математика:**
 * TokenBalance НЕ содержит математических операций.
 * Используй TokenBalanceService для add/subtract/multiply и т.д.
 *
 * @example
 * ```typescript
 * // ✅ В Core/Facade layer
 * import { accountIdFromWallet, KnownVenues } from '@polymarket/ids';
 *
 * const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
 * const qty = Quantity.of(new Decimal(100));
 * const accountId = accountIdFromWallet('0x1234...').unwrap();
 * const balance = TokenBalance.of(token, qty, accountId, KnownVenues.POLYMARKET);
 *
 * // ❌ В публичном коде - используй TokenBalanceService
 * const result = TokenBalanceService.create(token, qty, accountId, venueId);
 * if (result.ok) {
 *   const balance = result.value;
 *   console.log(balance.amount().toNumber()); // 100
 *   console.log(balance.venueId()); // 'POLYMARKET'
 * }
 * ```
 */
export class TokenBalance {
  private constructor(
    private readonly _token: OutcomeToken,
    private readonly _amount: Quantity,
    private readonly _accountId: AccountId,
    private readonly _venueId: VenueId
  ) {}

  /**
   * Создаёт TokenBalance из OutcomeToken, Quantity, AccountId и VenueId
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Валидация минимальна - проверяет что объекты существуют.
   * Invariants уже гарантированы OutcomeToken, Quantity, AccountId и VenueId.
   *
   * Для публичного API используйте TokenBalanceService.create().
   *
   * @param token - Outcome token
   * @param amount - Количество токенов (должно быть non-negative, уже проверено в Quantity)
   * @param accountId - ID аккаунта владельца баланса
   * @param venueId - ID площадки (venue) где находится баланс
   * @returns Новый TokenBalance
   * @throws {TokenBalanceInvariantViolation} Если инварианты нарушены (не должно происходить)
   *
   * @example
   * ```typescript
   * // ✅ В Core/Facade
   * import { accountIdFromWallet, KnownVenues } from '@polymarket/ids';
   *
   * const token = OutcomeToken.of(conditionRef, outcomeKey);
   * const qty = Quantity.of(new Decimal(100));
   * const accountId = accountIdFromWallet('0x1234...').unwrap();
   * const balance = TokenBalance.of(token, qty, accountId, KnownVenues.POLYMARKET);
   *
   * // ❌ В публичном коде - используй TokenBalanceService
   * const result = TokenBalanceService.create(token, qty, accountId, venueId);
   * ```
   */
  public static of(
    token: OutcomeToken,
    amount: Quantity,
    accountId: AccountId,
    venueId: VenueId
  ): TokenBalance {
    // Инварианты уже проверены в OutcomeToken, Quantity, AccountId и VenueId
    // Amount non-negative гарантирован Quantity конструктором
    return new TokenBalance(token, amount, accountId, venueId);
  }

  /**
   * Возвращает outcome token
   *
   * @returns OutcomeToken
   *
   * @example
   * ```typescript
   * const balance = TokenBalance.of(token, qty, accountId, venueId);
   * const token = balance.token();
   * console.log(token.outcomeKey()); // 'UP'
   * ```
   */
  public token(): OutcomeToken {
    return this._token;
  }

  /**
   * Возвращает количество токенов
   *
   * @returns Quantity
   *
   * @example
   * ```typescript
   * const balance = TokenBalance.of(token, qty, accountId, venueId);
   * const amount = balance.amount();
   * console.log(amount.toNumber()); // 100
   * ```
   */
  public amount(): Quantity {
    return this._amount;
  }

  /**
   * Возвращает ID аккаунта владельца баланса
   *
   * @returns AccountId
   *
   * @example
   * ```typescript
   * const balance = TokenBalance.of(token, qty, accountId, venueId);
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
   * const balance = TokenBalance.of(token, qty, accountId, venueId);
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
   * const balance = TokenBalance.of(token, qty, accountId, venueId);
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
   * const balance = TokenBalance.of(token, qty, accountId, venueId);
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
   * const balance = TokenBalance.of(token, qty, accountId, venueId);
   * const key = balance.outcomeKey();
   * console.log(key); // 'UP'
   * ```
   */
  public outcomeKey(): OutcomeKey {
    return this._token.outcomeKey();
  }

  /**
   * Проверяет равенство с другим TokenBalance
   *
   * @remarks
   * Два баланса равны если:
   * - Их токены равны (token.equals)
   * - Их количества равны (amount.equals)
   * - Их аккаунты равны (accountIdEquals)
   * - Их venues равны (venueId === venueId)
   *
   * @param other - Другой TokenBalance для сравнения
   * @returns true если балансы представляют одинаковый токен, количество, аккаунт и venue
   *
   * @example
   * ```typescript
   * const balance1 = TokenBalance.of(token, Quantity.of(new Decimal(100)), accountId, venueId);
   * const balance2 = TokenBalance.of(token, Quantity.of(new Decimal(100)), accountId, venueId);
   * const balance3 = TokenBalance.of(token, Quantity.of(new Decimal(200)), accountId, venueId);
   *
   * balance1.equals(balance2); // true
   * balance1.equals(balance3); // false (разное количество)
   * ```
   */
  public equals(other: TokenBalance): boolean {
    return (
      this._token.equals(other._token) &&
      this._amount.equals(other._amount) &&
      accountIdEquals(this._accountId, other._accountId) &&
      this._venueId === other._venueId
    );
  }

  /**
   * Проверяет что баланс нулевой
   *
   * @remarks
   * Баланс нулевой если amount равно 0.
   * Полезно для проверки пустых позиций.
   *
   * @returns true если amount равно 0
   *
   * @example
   * ```typescript
   * const zeroBalance = TokenBalance.of(token, Quantity.ZERO);
   * const nonZeroBalance = TokenBalance.of(token, Quantity.of(new Decimal(100)));
   *
   * zeroBalance.isZero();    // true
   * nonZeroBalance.isZero(); // false
   * ```
   */
  public isZero(): boolean {
    return this._amount.isZero();
  }

  /**
   * Проверяет что баланс положительный
   *
   * @remarks
   * Баланс положительный если amount > 0.
   * Полезно для проверки активных позиций.
   *
   * @returns true если amount > 0
   *
   * @example
   * ```typescript
   * const zeroBalance = TokenBalance.of(token, Quantity.ZERO);
   * const positiveBalance = TokenBalance.of(token, Quantity.of(new Decimal(100)));
   *
   * zeroBalance.isPositive();    // false
   * positiveBalance.isPositive(); // true
   * ```
   */
  public isPositive(): boolean {
    return this._amount.isPositive();
  }
}
