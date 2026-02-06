import type { AssetId, OnChainConditionRef, OutcomeKey } from '@polymarket/ids';
import { OutcomeToken } from '../../outcome-token/core/OutcomeToken.js';
import { Quantity } from '../../quantity/core/Quantity.js';

/**
 * Core TokenBalance Value Object
 *
 * @remarks
 * Представляет баланс outcome token на кошельке/venue.
 * Сочетает информацию о токене (OutcomeToken) и количестве (Quantity).
 *
 * **Иммутабельность:**
 * - Все поля readonly
 * - Не предоставляет методов изменения
 * - Для изменений создавайте новый TokenBalance
 *
 * **Инварианты:**
 * - token должен быть валидным OutcomeToken
 * - amount должен быть валидным Quantity (non-negative, finite)
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
 * const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
 * const qty = Quantity.of(new Decimal(100));
 * const balance = TokenBalance.of(token, qty);
 *
 * // ❌ В публичном коде - используй TokenBalanceService
 * const result = TokenBalanceService.create(token, qty);
 * if (result.ok) {
 *   const balance = result.value;
 *   console.log(balance.amount().toNumber()); // 100
 * }
 * ```
 */
export class TokenBalance {
  private constructor(
    private readonly _token: OutcomeToken,
    private readonly _amount: Quantity
  ) {}

  /**
   * Создаёт TokenBalance из OutcomeToken и Quantity
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Валидация минимальна - проверяет что объекты существуют.
   * Invariants уже гарантированы OutcomeToken и Quantity конструкторами.
   *
   * Для публичного API используйте TokenBalanceService.create().
   *
   * @param token - Outcome token
   * @param amount - Количество токенов (должно быть non-negative, уже проверено в Quantity)
   * @returns Новый TokenBalance
   * @throws {TokenBalanceInvariantViolation} Если инварианты нарушены (не должно происходить)
   *
   * @example
   * ```typescript
   * // ✅ В Core/Facade
   * const token = OutcomeToken.of(conditionRef, outcomeKey);
   * const qty = Quantity.of(new Decimal(100));
   * const balance = TokenBalance.of(token, qty);
   *
   * // ❌ В публичном коде - используй TokenBalanceService
   * const result = TokenBalanceService.create(token, qty);
   * ```
   */
  public static of(token: OutcomeToken, amount: Quantity): TokenBalance {
    // Инварианты уже проверены в OutcomeToken и Quantity
    // Amount non-negative гарантирован Quantity конструктором
    return new TokenBalance(token, amount);
  }

  /**
   * Возвращает outcome token
   *
   * @returns OutcomeToken
   *
   * @example
   * ```typescript
   * const balance = TokenBalance.of(token, qty);
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
   * const balance = TokenBalance.of(token, qty);
   * const amount = balance.amount();
   * console.log(amount.toNumber()); // 100
   * ```
   */
  public amount(): Quantity {
    return this._amount;
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
   * const balance = TokenBalance.of(token, qty);
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
   * const balance = TokenBalance.of(token, qty);
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
   * const balance = TokenBalance.of(token, qty);
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
   *
   * @param other - Другой TokenBalance для сравнения
   * @returns true если балансы представляют одинаковый токен и количество
   *
   * @example
   * ```typescript
   * const balance1 = TokenBalance.of(token, Quantity.of(new Decimal(100)));
   * const balance2 = TokenBalance.of(token, Quantity.of(new Decimal(100)));
   * const balance3 = TokenBalance.of(token, Quantity.of(new Decimal(200)));
   *
   * balance1.equals(balance2); // true
   * balance1.equals(balance3); // false (разное количество)
   * ```
   */
  public equals(other: TokenBalance): boolean {
    return this._token.equals(other._token) && this._amount.equals(other._amount);
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
