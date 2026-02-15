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
 * **Инварианты:**
 * AssetQuantity гарантирует (через делегирование в Quantity):
 * - amount >= 0 (non-negative, проверяется Quantity инвариантом)
 * - amount is finite (не NaN, не Infinity)
 * - asset is frozen (иммутабельность через AssetIdHelpers.deepFreeze)
 *
 * **Допустимые значения:**
 * - ✅ amount = 0 (zero balance)
 * - ✅ amount > 0 (positive balance)
 * - ❌ amount < 0 (negative не допускается, Quantity бросит QuantityInvariantViolation)
 *
 * **Иммутабельность:**
 * - Гарантируется через defensive copy в fromAssetId()
 * - Внешний AssetId пересоздаётся, не сохраняется напрямую
 * - После создания нет публичных методов для изменения состояния
 *
 * **Публичные фабрики**:
 * - `of(asset, amount)` - создание из канонических domain объектов
 * - `fromAssetId(assetId, amount)` - создание с defensive copy (для adapters/boundary)
 * - `usdc(amount)` - convenience для USDC
 * - `outcomeToken(ref, key, amount)` - convenience для outcome tokens
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
   * Приватная фабрика для создания из канонического AssetId
   *
   * @param asset - Канонический AssetId (из AssetId)
   * @param amount - Количество актива
   * @returns Новый AssetQuantity
   *
   * @remarks
   * Вызывается из of() и fromAssetId() после создания канонического AssetIdHelpers.
   * НЕ делает повторную каноникализацию - доверяет что asset уже канонический.
   */
  private static fromCanonicalAssetId(asset: AssetId, amount: Quantity): AssetQuantity {
    return new AssetQuantity(asset, amount);
  }

  /**
   * Создаёт AssetQuantity из AssetId с defensive copy
   *
   * @param asset - Asset identifier (может быть из ненадёжного источника)
   * @param amount - Количество актива
   * @returns Новый AssetQuantity
   * @throws {Error} Если AssetId бросит при пересоздании
   *
   * @remarks
   * **Defensive copy**: Пересоздаёт AssetId для гарантии иммутабельности.
   * Входной asset может быть из parseAssetId (mutable).
   *
   * - CURRENCY: использует исходный (constants уже frozen)
   * - OUTCOME_TOKEN: пересоздаёт через AssetIdHelpers.fromOutcomeToken()
   *
   * @example
   * ```typescript
   * const assetId = parseAssetId("outcome_token:...");  // mutable
   * const qty = Quantity.of(new Decimal(100));
   * const assetQty = AssetQuantity.fromAssetId(assetId, qty);
   * ```
   */
  public static fromAssetId(asset: AssetId, amount: Quantity): AssetQuantity {
    // Проверяем, frozen ли AssetId (гарантия иммутабельности)
    // Если frozen - можно использовать напрямую (уже из AssetId)
    // Если нет - пересоздаём через AssetId для гарантии freeze
    const isFrozen = Object.isFrozen(asset);

    if (isFrozen) {
      // AssetId уже frozen (из AssetId), используем напрямую
      return AssetQuantity.fromCanonicalAssetId(asset, amount);
    }

    // AssetId не frozen (из parseAssetId или создан вручную)
    // Пересоздаём через AssetId для гарантии иммутабельности
    const canonicalAsset =
      asset.type === 'CURRENCY'
        ? AssetIdHelpers.fromCurrency(asset.currency)
        : AssetIdHelpers.fromOutcomeToken(asset.conditionRef, asset.outcomeKey);

    return AssetQuantity.fromCanonicalAssetId(canonicalAsset, amount);
  }

  /**
   * Создаёт AssetQuantity из канонического AssetId и Quantity
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Для создания из AssetId (уже канонический).
   * НЕ делает defensive copy - доверяет что asset уже канонический.
   *
   * Для boundary/adapters используйте fromAssetId() с defensive copy.
   *
   * @param asset - Канонический AssetId (из AssetId)
   * @param amount - Количество актива
   * @returns Новый AssetQuantity
   *
   * @example
   * ```typescript
   * // ✅ В Core/Facade с AssetId
   * const assetId = AssetIdHelpers.USDC;
   * const qty = Quantity.of(new Decimal(100));
   * const assetQty = AssetQuantity.of(assetId, qty);
   * ```
   */
  public static of(asset: AssetId, amount: Quantity): AssetQuantity {
    // AssetId уже канонический (из AssetId)
    return AssetQuantity.fromCanonicalAssetId(asset, amount);
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
    return AssetQuantity.fromCanonicalAssetId(AssetIdHelpers.USDC, amount);
  }

  /**
   * Factory: создаёт AssetQuantity для outcome token
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Convenience метод для создания outcome token asset quantity.
   * Создаёт канонический AssetId из conditionRef + outcomeKey.
   *
   * Для публичного API используйте AssetQuantityService.createOutcomeToken().
   *
   * @param conditionRef - On-chain condition reference
   * @param outcomeKey - Outcome key (UP, DOWN, etc)
   * @param amount - Количество токенов
   * @returns AssetQuantity для outcome token
   * @throws {Error} Если AssetIdHelpers.fromOutcomeToken() бросит
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
    // Создаём канонический AssetId
    const assetId = AssetIdHelpers.fromOutcomeToken(conditionRef, outcomeKey);
    return AssetQuantity.fromCanonicalAssetId(assetId, amount);
  }

  /**
   * Возвращает asset identifier
   *
   * @returns AssetId (может быть Currency или OutcomeToken)
   *
   * @remarks
   * **Иммутабельность гарантирована:**
   * - _asset всегда создаётся через AssetId (fromAssetId, of, usdc, outcomeToken)
   * - AssetId всегда возвращает deep frozen AssetId
   * - Object.freeze() предотвращает мутации в runtime
   * - Поэтому можно безопасно возвращать _asset напрямую без копирования
   *
   * @example
   * ```typescript
   * const assetQty = AssetQuantity.usdc(qty);
   * const asset = assetQty.asset();
   * console.log(asset.type); // 'CURRENCY'
   * console.log(asset.currency); // 'USDC'
   *
   * // ❌ Попытка мутации не сработает (frozen):
   * // (asset as any).currency = 'HACKED'; // Throws in strict mode
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
    // Используем AssetIdHelpers.equals() для проверки равенства asset (DRY)
    // Если AssetId изменится, логика обновится автоматически в одном месте
    if (!AssetIdHelpers.equals(this._asset, other._asset)) {
      return false;
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
