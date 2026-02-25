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
 * console.log(totalFee.quantity.amount().toNumber()); // 0.10
 *
 * // Проверка равенства
 * if (fee.equals(totalFee)) {
 *   console.log('Same fee');
 * }
 * ```
 */

import type { AssetId } from '@polymarket/ids';
import { AssetIdHelpers } from '@polymarket/ids';
import { InvalidFeeError } from '@polymarket/errors';
import { AssetQuantity } from '../../asset-quantity/core/AssetQuantity.js';
import { Quantity } from '../../quantity/core/Quantity.js';

/**
 * Fee - комиссия в любом активе
 *
 * @remarks
 * Immutable value object для представления комиссий.
 * Wrapper над AssetQuantity с семантикой "fee" (всегда >= 0).
 */
export class Fee {
  /**
   * Приватный конструктор - используйте static фабрики
   *
   * @param _quantity - AssetQuantity с amount >= 0
   *
   * @remarks
   * Конструктор приватный, чтобы обеспечить валидацию через фабрики.
   * AssetQuantity уже гарантирует amount >= 0 через Quantity инвариант.
   */
  private constructor(private readonly _quantity: AssetQuantity) {}

  /**
   * Создать Fee из AssetQuantity
   *
   * @param quantity - Количество актива (должно быть >= 0)
   * @returns Fee
   *
   * @remarks
   * AssetQuantity уже гарантирует amount >= 0 через Quantity инвариант,
   * поэтому дополнительная валидация не требуется.
   *
   * @example
   * ```typescript
   * const qty = Quantity.of(new Decimal('0.10'));
   * const assetQty = AssetQuantity.usdc(qty);
   * const fee = Fee.of(assetQty);
   * console.log(fee.quantity.amount().toNumber()); // 0.10
   * ```
   */
  public static of(quantity: AssetQuantity): Fee {
    return new Fee(quantity);
  }

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
  public static zero(asset: AssetId): Fee {
    return new Fee(new AssetQuantity(asset, Quantity.ZERO));
  }

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
  public get quantity(): AssetQuantity {
    return this._quantity;
  }

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
  public get asset(): AssetId {
    return this._quantity.asset();
  }

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
  public isZero(): boolean {
    return this._quantity.isZero();
  }

  /**
   * Сложить две комиссии
   *
   * @param other - Другая комиссия
   * @returns Новая Fee с суммированным amount
   * @throws {InvalidFeeError} Если assets не совпадают
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
   * // usdcFee.add(tokenFee); // Throws InvalidFeeError
   * ```
   */
  public add(other: Fee): Fee {
    // Проверяем что assets совпадают
    if (!AssetIdHelpers.equals(this.asset, other.asset)) {
      throw new InvalidFeeError(
        `Cannot add fees with different assets: ${JSON.stringify(this.asset)} vs ${JSON.stringify(other.asset)}`,
        {
          context: {
            asset1: this.asset,
            asset2: other.asset,
            reason: 'ASSET_MISMATCH',
          },
        }
      );
    }

    // Складываем amounts через Decimal arithmetic
    const sumDecimal = this._quantity.amount().value().add(other._quantity.amount().value());

    // Создаём новый Quantity из суммы
    const sumAmount = Quantity.of(sumDecimal);

    // Создаём новый AssetQuantity с суммированным amount
    const sumQuantity = new AssetQuantity(this.asset, sumAmount);

    return new Fee(sumQuantity);
  }

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
  public equals(other: Fee): boolean {
    return this._quantity.equals(other._quantity);
  }

  /**
   * Преобразовать в строку для отладки
   *
   * @returns Строка с asset и amount
   *
   * @example
   * ```typescript
   * const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
   * console.log(fee.toString());
   * // "Fee(CURRENCY:USDC, 0.10)"
   * ```
   */
  public toString(): string {
    const assetStr = this.asset.type === 'CURRENCY'
      ? `CURRENCY:${this.asset.currency}`
      : `OUTCOME_TOKEN:${this.asset.conditionRef.conditionId}:${this.asset.outcomeKey}`;

    return `Fee(${assetStr}, ${this._quantity.amount().toNumber()})`;
  }
}
