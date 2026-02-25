/**
 * Фасад для работы с Fee - публичный API
 *
 * @remarks
 * Единая точка входа для создания Fee с Result pattern.
 *
 * @example
 * ```typescript
 * import { FeeService } from '@polymarket/value-objects';
 *
 * const assetQty = AssetQuantity.usdc(Quantity.of(new Decimal('0.10')));
 * const fee = FeeService.of(assetQty);
 * console.log(fee.quantity.amount().toNumber()); // 0.10
 * ```
 */

import type { AssetId } from '@polymarket/ids';
import { Fee } from '../core/Fee.js';
import { AssetQuantity } from '../../asset-quantity/core/AssetQuantity.js';

export class FeeService {
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
   * const fee = FeeService.of(assetQty);
   * console.log(fee.quantity.amount().toNumber()); // 0.10
   * ```
   */
  public static of(quantity: AssetQuantity): Fee {
    return Fee.of(quantity);
  }

  /**
   * Создать нулевую комиссию для указанного актива
   *
   * @param asset - Asset identifier
   * @returns Fee с amount = 0
   *
   * @example
   * ```typescript
   * import { AssetIdHelpers } from '@polymarket/ids';
   *
   * const zeroFee = FeeService.zero(AssetIdHelpers.USDC);
   * console.log(zeroFee.isZero()); // true
   * ```
   */
  public static zero(asset: AssetId): Fee {
    return Fee.zero(asset);
  }

  /**
   * Сложить две комиссии
   *
   * @param fee1 - Первая комиссия
   * @param fee2 - Вторая комиссия
   * @returns Новая Fee с суммированным amount
   * @throws {Error} Если assets не совпадают
   *
   * @example
   * ```typescript
   * const total = FeeService.add(fee1, fee2);
   * console.log(total.quantity.amount().toNumber());
   * ```
   */
  public static add(fee1: Fee, fee2: Fee): Fee {
    return fee1.add(fee2);
  }

  /**
   * Проверить равенство двух fees
   *
   * @param fee1 - Первая Fee
   * @param fee2 - Вторая Fee
   * @returns true если fees равны
   *
   * @example
   * ```typescript
   * if (FeeService.equals(fee1, fee2)) {
   *   console.log('Same fee');
   * }
   * ```
   */
  public static equals(fee1: Fee, fee2: Fee): boolean {
    return fee1.equals(fee2);
  }
}
