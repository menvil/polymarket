import type { AssetId, OnChainConditionRef, OutcomeKey } from '@polymarket/ids';
import { AssetIdHelpers } from '@polymarket/ids';
import { Quantity } from '../../quantity/core/Quantity.js';

/**
 * Core AssetQuantity Value Object
 *
 * @remarks
 * Представляет количество любого актива: Currency (USDC) или OutcomeToken.
 * Generic контейнер для работы с mixed assets в portfolio, transfers, settlements.
 *
 * **Отличие от TokenBalance:**
 * - TokenBalance: Type-safe для outcome tokens specifically (compile-time guarantee)
 * - AssetQuantity: Generic для ANY assets (runtime type checks)
 *
 * **Иммутабельность:**
 * - Все поля readonly
 * - Не предоставляет методов изменения
 * - Для изменений создавайте новый AssetQuantity
 *
 * **Инварианты:**
 * - asset должен быть валидным AssetId
 * - amount должен быть валидным Quantity (non-negative, finite)
 * - Нет дополнительных инвариантов
 *
 * **Core не использует Result:**
 * Если нарушены инварианты — бросает AssetQuantityInvariantViolation.
 * Facade перехватывает и конвертирует в Result.Err.
 *
 * @example
 * ```typescript
 * // ✅ В Core/Facade layer
 * const assetId = AssetIdHelpers.USDC;
 * const qty = Quantity.of(new Decimal(100));
 * const assetQty = AssetQuantity.of(assetId, qty);
 *
 * // ❌ В публичном коде - используй AssetQuantityService
 * const result = AssetQuantityService.create(assetId, qty);
 * if (result.ok) {
 *   const assetQty = result.value;
 *   console.log(assetQty.amount().toNumber()); // 100
 *   console.log(assetQty.isCurrency()); // true
 * }
 * ```
 */
export class AssetQuantity {
  private constructor(
    private readonly _asset: AssetId,
    private readonly _amount: Quantity
  ) {}

  /**
   * Создаёт AssetQuantity из AssetId и Quantity
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Валидация минимальна - проверяет что объекты существуют.
   * Invariants уже гарантированы AssetId и Quantity структурами.
   *
   * Для публичного API используйте AssetQuantityService.create().
   *
   * @param asset - Asset identifier (Currency или OutcomeToken)
   * @param amount - Количество актива (должно быть non-negative, уже проверено в Quantity)
   * @returns Новый AssetQuantity
   * @throws {AssetQuantityInvariantViolation} Если инварианты нарушены (не должно происходить)
   *
   * @example
   * ```typescript
   * // ✅ В Core/Facade
   * const assetId = AssetIdHelpers.USDC;
   * const qty = Quantity.of(new Decimal(100));
   * const assetQty = AssetQuantity.of(assetId, qty);
   *
   * // ❌ В публичном коде - используй AssetQuantityService
   * const result = AssetQuantityService.create(assetId, qty);
   * ```
   */
  public static of(asset: AssetId, amount: Quantity): AssetQuantity {
    // Инварианты уже проверены в AssetId и Quantity
    // Amount non-negative гарантирован Quantity конструктором
    return new AssetQuantity(asset, amount);
  }

  /**
   * Factory: создаёт AssetQuantity для USDC
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Convenience метод для создания USDC asset quantity.
   * Для публичного API используйте AssetQuantityService.createUsdc().
   *
   * @param amount - Количество USDC
   * @returns AssetQuantity для USDC
   *
   * @example
   * ```typescript
   * // ✅ В Core/Facade
   * const qty = Quantity.of(new Decimal(100));
   * const usdcQty = AssetQuantity.usdc(qty);
   *
   * // ❌ В публичном коде
   * const result = AssetQuantityService.createUsdc(100);
   * ```
   */
  public static usdc(amount: Quantity): AssetQuantity {
    return new AssetQuantity(AssetIdHelpers.USDC, amount);
  }

  /**
   * Factory: создаёт AssetQuantity для outcome token
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Convenience метод для создания outcome token asset quantity.
   * Создаёт AssetId из conditionRef + outcomeKey и оборачивает в AssetQuantity.
   *
   * Для публичного API используйте AssetQuantityService.createOutcomeToken().
   *
   * @param conditionRef - On-chain condition reference
   * @param outcomeKey - Outcome key (UP, DOWN, etc)
   * @param amount - Количество токенов
   * @returns AssetQuantity для outcome token
   *
   * @example
   * ```typescript
   * // ✅ В Core/Facade
   * const qty = Quantity.of(new Decimal(100));
   * const tokenQty = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.UP, qty);
   *
   * // ❌ В публичном коде
   * const result = AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 100);
   * ```
   */
  public static outcomeToken(
    conditionRef: OnChainConditionRef,
    outcomeKey: OutcomeKey,
    amount: Quantity
  ): AssetQuantity {
    const assetId = AssetIdHelpers.fromOutcomeToken(conditionRef, outcomeKey);
    return new AssetQuantity(assetId, amount);
  }

  /**
   * Возвращает asset identifier
   *
   * @returns AssetId (может быть Currency или OutcomeToken)
   *
   * @example
   * ```typescript
   * const assetQty = AssetQuantity.usdc(qty);
   * const asset = assetQty.asset();
   * console.log(asset.type); // 'CURRENCY'
   * console.log(asset.currency); // 'USDC'
   * ```
   */
  public asset(): AssetId {
    return this._asset;
  }

  /**
   * Возвращает количество актива
   *
   * @returns Quantity
   *
   * @example
   * ```typescript
   * const assetQty = AssetQuantity.usdc(qty);
   * const amount = assetQty.amount();
   * console.log(amount.toNumber()); // 100
   * ```
   */
  public amount(): Quantity {
    return this._amount;
  }

  /**
   * Type guard: проверяет что asset это Currency
   *
   * @remarks
   * Используй для type narrowing в runtime.
   * После этой проверки TypeScript знает что asset.type === 'CURRENCY'.
   *
   * @returns true если asset это Currency (USDC и т.д.)
   *
   * @example
   * ```typescript
   * const assetQty = AssetQuantity.usdc(qty);
   * if (assetQty.isCurrency()) {
   *   console.log(assetQty.asset().currency); // ✅ TypeScript knows this is safe
   * }
   * ```
   */
  public isCurrency(): boolean {
    return this._asset.type === 'CURRENCY';
  }

  /**
   * Type guard: проверяет что asset это OutcomeToken
   *
   * @remarks
   * Используй для type narrowing в runtime.
   * После этой проверки TypeScript знает что asset.type === 'OUTCOME_TOKEN'.
   *
   * @returns true если asset это OutcomeToken
   *
   * @example
   * ```typescript
   * const assetQty = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.UP, qty);
   * if (assetQty.isOutcomeToken()) {
   *   console.log(assetQty.asset().outcomeKey); // ✅ TypeScript knows this is safe
   * }
   * ```
   */
  public isOutcomeToken(): boolean {
    return this._asset.type === 'OUTCOME_TOKEN';
  }

  /**
   * Проверяет равенство с другим AssetQuantity
   *
   * @remarks
   * Два asset quantities равны если:
   * - Их assets равны (same type + same identifier)
   * - Их amounts равны (amount.equals)
   *
   * Для Currency: проверяется currency
   * Для OutcomeToken: проверяется conditionRef + outcomeKey
   *
   * @param other - Другой AssetQuantity для сравнения
   * @returns true если asset quantities представляют одинаковый актив и количество
   *
   * @example
   * ```typescript
   * const qty1 = AssetQuantity.usdc(Quantity.of(new Decimal(100)));
   * const qty2 = AssetQuantity.usdc(Quantity.of(new Decimal(100)));
   * const qty3 = AssetQuantity.usdc(Quantity.of(new Decimal(200)));
   *
   * qty1.equals(qty2); // true (same asset, same amount)
   * qty1.equals(qty3); // false (same asset, different amount)
   * ```
   */
  public equals(other: AssetQuantity): boolean {
    // Проверка типа актива
    if (this._asset.type !== other._asset.type) {
      return false;
    }

    // Проверка равенства asset identifier
    if (this._asset.type === 'CURRENCY') {
      if (this._asset.currency !== (other._asset as Extract<AssetId, { type: 'CURRENCY' }>).currency) {
        return false;
      }
    } else {
      // OUTCOME_TOKEN
      const thisToken = this._asset as Extract<AssetId, { type: 'OUTCOME_TOKEN' }>;
      const otherToken = other._asset as Extract<AssetId, { type: 'OUTCOME_TOKEN' }>;

      // Сравниваем conditionRef
      const thisRef = thisToken.conditionRef;
      const otherRef = otherToken.conditionRef;

      if (
        thisRef.kind !== otherRef.kind ||
        thisRef.protocolId !== otherRef.protocolId ||
        thisRef.chainId !== otherRef.chainId ||
        thisRef.conditionId !== otherRef.conditionId
      ) {
        return false;
      }

      // Сравниваем outcomeKey
      if (thisToken.outcomeKey !== otherToken.outcomeKey) {
        return false;
      }
    }

    // Проверка равенства amount
    return this._amount.equals(other._amount);
  }

  /**
   * Проверяет что количество нулевое
   *
   * @remarks
   * Количество нулевое если amount равно 0.
   * Полезно для проверки пустых позиций.
   *
   * @returns true если amount равно 0
   *
   * @example
   * ```typescript
   * const zeroQty = AssetQuantity.usdc(Quantity.ZERO);
   * const nonZeroQty = AssetQuantity.usdc(Quantity.of(new Decimal(100)));
   *
   * zeroQty.isZero();    // true
   * nonZeroQty.isZero(); // false
   * ```
   */
  public isZero(): boolean {
    return this._amount.isZero();
  }

  /**
   * Проверяет что количество положительное
   *
   * @remarks
   * Количество положительное если amount > 0.
   * Полезно для проверки активных позиций.
   *
   * @returns true если amount > 0
   *
   * @example
   * ```typescript
   * const zeroQty = AssetQuantity.usdc(Quantity.ZERO);
   * const positiveQty = AssetQuantity.usdc(Quantity.of(new Decimal(100)));
   *
   * zeroQty.isPositive();    // false
   * positiveQty.isPositive(); // true
   * ```
   */
  public isPositive(): boolean {
    return this._amount.isPositive();
  }
}
