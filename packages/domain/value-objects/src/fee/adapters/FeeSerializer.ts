/**
 * Serializer для Fee
 *
 * @remarks
 * Преобразует Fee в/из JSON.
 * JSON формат: { asset: AssetId, amount: number }
 *
 * @example
 * ```typescript
 * import { FeeSerializer } from '@polymarket/value-objects';
 *
 * const fee = Fee.zero(AssetIdHelpers.USDC);
 * const json = FeeSerializer.toJSON(fee);
 * // { asset: { type: 'CURRENCY', currency: 'USDC' }, amount: 0 }
 *
 * const result = FeeSerializer.fromJSON(json);
 * if (result.ok) {
 *   console.log(result.value.isZero()); // true
 * }
 * ```
 */

import { Result, Ok } from '@polymarket/result';
import { ValidationError, wrapOp } from '@polymarket/errors';
import type { AssetId } from '@polymarket/ids';
import { Fee } from '../core/Fee.js';
import { AssetQuantity } from '../../asset-quantity/core/AssetQuantity.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { FeeErrorReason } from '../errors/FeeErrorReason.js';
import Decimal from 'decimal.js';

/**
 * JSON представление Fee
 */
export interface FeeJSON {
  readonly asset: AssetId;
  readonly amount: number;
}

export class FeeSerializer {
  /**
   * Сериализовать Fee в JSON
   *
   * @param fee - Fee для сериализации
   * @returns FeeJSON объект
   *
   * @example
   * ```typescript
   * const fee = Fee.zero(AssetIdHelpers.USDC);
   * const json = FeeSerializer.toJSON(fee);
   * console.log(json.amount); // 0
   * ```
   */
  public static toJSON(fee: Fee): FeeJSON {
    return {
      asset: fee.asset,
      amount: fee.quantity.amount().toNumber(),
    };
  }

  /**
   * Десериализовать Fee из JSON
   *
   * @param json - FeeJSON объект
   * @returns Result<Fee, ValidationError>
   *
   * @example
   * ```typescript
   * const json = { asset: AssetIdHelpers.USDC, amount: 0.10 };
   * const result = FeeSerializer.fromJSON(json);
   * if (result.ok) {
   *   console.log(result.value.quantity.amount().toNumber()); // 0.10
   * }
   * ```
   */
  public static fromJSON(json: FeeJSON): Result<Fee, ValidationError> {
    return wrapOp(
      'FeeSerializer',
      'fromJSON',
      { asset: json.asset, amount: json.amount },
      () => {
        // Создаём Quantity из amount
        const quantity = Quantity.of(new Decimal(json.amount));

        // Создаём AssetQuantity
        const assetQuantity = new AssetQuantity(json.asset, quantity);

        // Создаём Fee
        return Ok(Fee.of(assetQuantity));
      },
      ValidationError
    );
  }

  /**
   * Десериализовать Fee из unknown (с проверкой типов)
   *
   * @param json - Значение unknown
   * @returns Result<Fee, ValidationError>
   *
   * @remarks
   * Проверяет структуру объекта перед десериализацией.
   *
   * @example
   * ```typescript
   * const parsed: unknown = JSON.parse('{"asset": {...}, "amount": 0.10}');
   * const result = FeeSerializer.fromUnknown(parsed);
   * if (result.ok) {
   *   console.log(result.value.quantity.amount().toNumber());
   * }
   * ```
   */
  public static fromUnknown(json: unknown): Result<Fee, ValidationError> {
    return wrapOp(
      'FeeSerializer',
      'fromUnknown',
      { value: json, type: typeof json },
      () => {
        // Проверяем что json это объект
        if (typeof json !== 'object' || json === null) {
          throw new ValidationError('Fee must be object', {
            context: {
              field: 'fee',
              value: json,
              type: typeof json,
              reason: FeeErrorReason.INVALID_QUANTITY,
            },
          });
        }

        const obj = json as Record<string, unknown>;

        // Проверяем наличие полей
        if (!('asset' in obj) || !('amount' in obj)) {
          throw new ValidationError('Fee must have asset and amount fields', {
            context: {
              field: 'fee',
              value: json,
              reason: FeeErrorReason.INVALID_QUANTITY,
            },
          });
        }

        // Проверяем тип amount
        if (typeof obj.amount !== 'number') {
          throw new ValidationError('Fee amount must be number', {
            context: {
              field: 'amount',
              value: obj.amount,
              type: typeof obj.amount,
              reason: FeeErrorReason.INVALID_QUANTITY,
            },
          });
        }

        // Десериализуем через fromJSON
        const result = this.fromJSON({
          asset: obj.asset as AssetId,
          amount: obj.amount,
        });

        if (!result.ok) {
          throw result.error;
        }

        return result;
      },
      ValidationError
    );
  }
}
