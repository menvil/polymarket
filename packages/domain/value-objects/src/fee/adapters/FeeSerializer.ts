/**
 * Serializer для Fee
 *
 * @remarks
 * Преобразует Fee в/из JSON.
 * JSON формат: { asset: AssetId, amount: string }
 *
 * Amount хранится как string для сохранения точности при сериализации.
 *
 * @example
 * ```typescript
 * import { FeeSerializer } from '@polymarket/value-objects';
 *
 * const fee = Fee.zero(AssetIdHelpers.USDC);
 * const json = FeeSerializer.toJSON(fee);
 * // { asset: { type: 'CURRENCY', currency: 'USDC' }, amount: "0" }
 *
 * const result = FeeSerializer.fromJSON(json);
 * if (result.ok) {
 *   console.log(result.value.isZero()); // true
 * }
 * ```
 */

import { Result, Ok } from '@polymarket/result';
import { InvalidFeeError, wrapOp } from '@polymarket/errors';
import type { AssetId } from '@polymarket/ids';
import { validateFeeAsset } from '../facade/validateFeeAsset.js';
import { Fee } from '../core/Fee.js';
import { AssetQuantity } from '../../asset-quantity/core/AssetQuantity.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { FeeErrorReason } from '../errors/FeeErrorReason.js';
import Decimal from 'decimal.js';

/**
 * JSON представление Fee
 *
 * @remarks
 * amount хранится как string для сохранения точности (как в MoneySerializer, AssetQuantitySerializer).
 * Decimal.js может терять точность при конвертации в number для больших чисел.
 */
export interface FeeJSON {
  readonly asset: AssetId;
  readonly amount: string;
}

export class FeeSerializer {
  /**
   * Сериализовать Fee в JSON
   *
   * @param fee - Fee для сериализации
   * @returns FeeJSON объект
   *
   * @remarks
   * amount сериализуется как string для сохранения точности.
   *
   * @example
   * ```typescript
   * const fee = Fee.zero(AssetIdHelpers.USDC);
   * const json = FeeSerializer.toJSON(fee);
   * console.log(json.amount); // "0"
   * ```
   */
  public static toJSON(fee: Fee): FeeJSON {
    return {
      asset: fee.asset,
      amount: fee.quantity.amount().value().toString(),
    };
  }

  /**
   * Десериализовать Fee из JSON
   *
   * @param json - FeeJSON объект
   * @returns Result<Fee, InvalidFeeError>
   *
   * @remarks
   * amount принимается как string для сохранения точности.
   * Decimal constructor принимает string, number, или Decimal.
   *
   * @example
   * ```typescript
   * const json = { asset: AssetIdHelpers.USDC, amount: "0.10" };
   * const result = FeeSerializer.fromJSON(json);
   * if (result.ok) {
   *   console.log(result.value.quantity.amount().toNumber()); // 0.1
   * }
   * ```
   */
  public static fromJSON(json: FeeJSON): Result<Fee, InvalidFeeError> {
    return wrapOp(
      'FeeSerializer',
      'fromJSON',
      { asset: json.asset, amount: json.amount },
      () => {
        // Создаём Quantity из amount (Decimal принимает string)
        const quantity = Quantity.of(new Decimal(json.amount));

        // Создаём AssetQuantity
        const assetQuantity = new AssetQuantity(json.asset, quantity);

        // Создаём Fee
        return Ok(Fee.of(assetQuantity));
      },
      InvalidFeeError
    );
  }

  /**
   * Десериализовать Fee из unknown (с проверкой типов)
   *
   * @param json - Значение unknown
   * @returns Result<Fee, InvalidFeeError>
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
  public static fromUnknown(json: unknown): Result<Fee, InvalidFeeError> {
    return wrapOp(
      'FeeSerializer',
      'fromUnknown',
      { value: json, type: typeof json },
      () => {
        // 1. Проверяем что json это объект
        if (typeof json !== 'object' || json === null) {
          throw new InvalidFeeError('Fee must be object', {
            context: {
              field: 'fee',
              value: json,
              type: typeof json,
              reason: FeeErrorReason.INVALID_STRUCTURE,
            },
          });
        }

        const obj = json as Record<string, unknown>;

        // 2. Проверяем наличие полей
        if (!('asset' in obj) || !('amount' in obj)) {
          throw new InvalidFeeError('Fee must have asset and amount fields', {
            context: {
              field: 'fee',
              value: json,
              reason: FeeErrorReason.INVALID_STRUCTURE,
              missingFields: [
                !('asset' in obj) ? 'asset' : null,
                !('amount' in obj) ? 'amount' : null,
              ].filter(Boolean),
            },
          });
        }

        // 3. Проверяем тип amount (принимаем string или number для обратной совместимости)
        if (typeof obj.amount !== 'string' && typeof obj.amount !== 'number') {
          throw new InvalidFeeError('Fee amount must be string or number', {
            context: {
              field: 'amount',
              value: obj.amount,
              type: typeof obj.amount,
              reason: FeeErrorReason.INVALID_QUANTITY,
            },
          });
        }

        // 4. Валидируем AssetId (структура, типы, формат полей, поддерживаемые значения)
        const asset = obj.asset;
        const assetValidation = validateFeeAsset(asset, { service: 'FeeSerializer', op: 'fromUnknown' });
        if (!assetValidation.ok) {
          throw assetValidation.error;
        }

        // 5. Десериализуем через fromJSON (приводим amount к string)
        const result = this.fromJSON({
          asset: asset as AssetId,
          amount: String(obj.amount),
        });

        if (!result.ok) {
          throw result.error;
        }

        return result;
      },
      InvalidFeeError
    );
  }
}
