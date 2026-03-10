/**
 * Fee Value Object
 *
 * @remarks
 * Представляет комиссию (fee) в любом активе: Currency (USDC) или OutcomeToken.
 *
 * Fee является wrapper над AssetQuantity с дополнительными инвариантами:
 * - Комиссия не может быть отрицательной (enforced через AssetQuantity.amount() >= 0)
 * - Комиссии можно складывать только с совпадающим asset
 *
 * Инварианты:
 * - amount >= 0 (non-negative, гарантируется AssetQuantity)
 * - amount is finite (не NaN, не Infinity)
 * - asset is frozen (иммутабельность)
 *
 * Используется для:
 * - Trading fees (maker/taker fees)
 * - Settlement fees
 * - Gas fees в on-chain операциях
 * - Withdrawal fees
 *
 * @example
 * ```typescript
 * import { Fee } from '@polymarket/value-objects';
 * import { AssetIdHelpers } from '@polymarket/ids';
 * import { Quantity } from '@polymarket/value-objects';
 * import { Decimal } from 'decimal.js';
 *
 * // Создание fee из AssetQuantity
 * const qty = Quantity.of(new Decimal('0.10'));
 * const assetQty = AssetQuantity.usdc(qty);
 * const fee = Fee.of(assetQty);
 *
 * // Zero fee
 * const zeroFee = Fee.zero(AssetIdHelpers.USDC);
 * console.log(zeroFee.isZero()); // true
 *
 * // Сложение fees
 * const totalFee = fee.add(zeroFee);
 * console.log(totalFee.quantity.amount().toNumber()); // 0.1
 *
 * // Проверка равенства
 * if (fee.equals(totalFee)) {
 *   console.log('Same fee');
 * }
 * ```
 */
import type { AssetId } from '@polymarket/ids';
import { AssetQuantity } from '../../asset-quantity/core/AssetQuantity.js';
import { SignedQuantity } from '../../signed-quantity/core/SignedQuantity.js';
/**
 * Fee - комиссия в любом активе
 *
 * @remarks
 * Immutable value object для представления комиссий.
 * Wrapper над AssetQuantity с семантикой "fee" (всегда >= 0).
 */
export declare class Fee {
    private readonly _quantity;
    /**
     * Приватный конструктор - используйте static фабрики
     *
     * @param _quantity - AssetQuantity с amount >= 0
     *
     * @remarks
     * Конструктор приватный, чтобы обеспечить валидацию через фабрики.
     * AssetQuantity уже гарантирует amount >= 0 через Quantity инвариант.
     */
    private constructor();
    /**
     * Создать Fee из AssetQuantity
     *
     * @internal ТОЛЬКО для внутреннего использования в Core и Facade
     *
     * @param quantity - Количество актива (должно быть >= 0)
     * @returns Fee
     *
     * @remarks
     * НЕБЕЗОПАСНЫЙ метод - не проверяет инварианты, полагается на AssetQuantity.
     * Для публичного API используйте FeeService.create().
     *
     * AssetQuantity уже гарантирует amount >= 0 через Quantity инвариант,
     * но этот метод не проверяет это явно.
     *
     * @example
     * ```typescript
     * // ✅ В Core и Facade
     * const fee = Fee.of(assetQty);
     *
     * // ❌ В публичном коде - используй FeeService.create()
     * const result = FeeService.create(AssetIdHelpers.USDC, '0.10');
     * if (result.ok) {
     *   const fee = result.value;
     * }
     * ```
     */
    static of(quantity: AssetQuantity): Fee;
    /**
     * Создать нулевую комиссию для указанного актива
     *
     * @param asset - Asset identifier
     * @returns Fee с amount = 0
     *
     * @remarks
     * Convenience метод для создания zero fee.
     * Полезно для инициализации или когда комиссия не взимается.
     *
     * @example
     * ```typescript
     * import { AssetIdHelpers } from '@polymarket/ids';
     *
     * const zeroFee = Fee.zero(AssetIdHelpers.USDC);
     * console.log(zeroFee.isZero()); // true
     * console.log(zeroFee.quantity.amount().toNumber()); // 0
     * ```
     */
    static zero(asset: AssetId): Fee;
    /**
     * Получить AssetQuantity
     *
     * @returns AssetQuantity (asset + amount)
     *
     * @example
     * ```typescript
     * const fee = Fee.zero(AssetIdHelpers.USDC);
     * const qty = fee.quantity;
     * console.log(qty.asset().type); // 'CURRENCY'
     * console.log(qty.amount().toNumber()); // 0
     * ```
     */
    get quantity(): AssetQuantity;
    /**
     * Получить AssetId
     *
     * @returns AssetId (currency или outcome token)
     *
     * @remarks
     * Shortcut для fee.quantity.asset().
     *
     * @example
     * ```typescript
     * const fee = Fee.zero(AssetIdHelpers.USDC);
     * const asset = fee.asset;
     * console.log(asset.type); // 'CURRENCY'
     * if (asset.type === 'CURRENCY') {
     *   console.log(asset.currency); // 'USDC'
     * }
     * ```
     */
    get asset(): AssetId;
    /**
     * Проверить что комиссия нулевая
     *
     * @returns true если amount = 0
     *
     * @example
     * ```typescript
     * const zeroFee = Fee.zero(AssetIdHelpers.USDC);
     * const nonZeroFee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
     *
     * console.log(zeroFee.isZero());    // true
     * console.log(nonZeroFee.isZero()); // false
     * ```
     */
    isZero(): boolean;
    /**
     * Сложить две комиссии
     *
     * @param other - Другая комиссия
     * @returns Новая Fee с суммированным amount
     * @throws {FeeOperationError} Если assets не совпадают
     *
     * @remarks
     * Комиссии можно складывать только если их assets совпадают.
     * Использует AssetIdHelpers.equals() для проверки равенства assets.
     *
     * Amount складывается через Decimal arithmetic напрямую.
     *
     * @example
     * ```typescript
     * const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
     * const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.05'))));
     *
     * const total = fee1.add(fee2);
     * console.log(total.quantity.amount().toNumber()); // 0.15
     *
     * // ❌ Нельзя складывать fees с разными assets
     * const usdcFee = Fee.zero(AssetIdHelpers.USDC);
     * const tokenFee = Fee.zero(someTokenAsset);
     * // usdcFee.add(tokenFee); // Throws FeeOperationError
     * ```
     */
    add(other: Fee): Fee;
    /**
     * Проверить равенство с другой Fee
     *
     * @param other - Другая Fee для сравнения
     * @returns true если fees представляют одинаковый asset и amount
     *
     * @remarks
     * Две fees равны если их AssetQuantity равны (asset + amount).
     * Делегирует проверку в AssetQuantity.equals().
     *
     * @example
     * ```typescript
     * const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
     * const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
     * const fee3 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.20'))));
     *
     * console.log(fee1.equals(fee2)); // true (same asset, same amount)
     * console.log(fee1.equals(fee3)); // false (same asset, different amount)
     * ```
     */
    equals(other: Fee): boolean;
    /**
     * Возвращает знаковое изменение баланса от списания комиссии
     *
     * @returns Объект с asset и отрицательным amount в виде SignedQuantity
     *
     * @remarks
     * Инкапсулирует доступ к внутреннему представлению Fee.
     * Вместо того чтобы потребитель сам делал `fee.quantity.amount().value().negated()`,
     * Fee предоставляет готовый знаковый delta как SignedQuantity VO.
     *
     * Возвращаемый тип структурно совместим с `AssetDelta` из `@polymarket/fill`.
     * Fee не импортирует `AssetDelta` напрямую (избегаем циклической зависимости),
     * TypeScript проверяет совместимость структурно.
     *
     * ### Семантика:
     * - amount всегда <= 0: нулевая комиссия → 0, ненулевая → отрицательный
     * - asset совпадает с fee.asset (расчётный актив)
     *
     * @example
     * ```typescript
     * // Fee 0.02 USDC
     * const delta = fee.toDebitDelta();
     * console.log(delta.amount.toNumber());   // -0.02
     * console.log(delta.amount.isNegative()); // true
     * console.log(delta.asset);               // USDC AssetId
     *
     * // Zero fee
     * const zeroDelta = Fee.zero(AssetIdHelpers.USDC).toDebitDelta();
     * console.log(zeroDelta.amount.isZero()); // true
     * ```
     */
    toDebitDelta(): {
        readonly asset: AssetId;
        readonly amount: SignedQuantity;
    };
    /**
     * Преобразовать в строку для отладки
     *
     * @returns Строка с asset и amount
     *
     * @example
     * ```typescript
     * const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
     * console.log(fee.toString());
     * // "Fee(CURRENCY:USDC, 0.1)"
     * ```
     */
    toString(): string;
}
//# sourceMappingURL=Fee.d.ts.map