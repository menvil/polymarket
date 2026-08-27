/**
 * JSON round-trip цены актива.
 *
 * @remarks
 * Реализация общая для всех ценовых доменов (`shared/price/priceCodec`): форма
 * `{ value: string }` одинакова, различается только фабрика, через которую
 * значение проверяется инвариантом домена.
 *
 * Значение хранится СТРОКОЙ: `number` потерял бы точность на длинных
 * десятичных дробях вроде `78376.356031481042173952`, и round-trip перестал
 * бы возвращать исходное значение — а для цены актива это ровно тот случай,
 * который встречается в TWAP-наблюдениях.
 *
 * @example
 * ```typescript
 * const json = AssetPriceSerializer.toJSON(price); // { value: "78468.5" }
 * const restored = AssetPriceSerializer.fromJSON(json);
 * ```
 */
import type { Result } from '@polymarket/result';
import type { InvalidAssetPriceError } from '@polymarket/errors';
import type { AssetPrice } from '../core/AssetPrice.js';
import type { PriceJSON } from '../../shared/price/priceCodec.js';
import { priceFromJSON, priceToJSON } from '../../shared/price/priceCodec.js';
import { ASSET_PRICE_DOMAIN } from '../facade/AssetPriceService.js';

/** JSON-представление цены актива. */
export type AssetPriceJSON = PriceJSON;

export class AssetPriceSerializer {
  /** Имя сервиса в контексте ошибок. */
  private static readonly SERVICE_NAME = 'AssetPriceSerializer';

  /**
   * Восстанавливает цену актива из JSON.
   *
   * @param json - Произвольное значение из внешнего источника
   * @returns Цена либо `InvalidAssetPriceError` с причиной отказа
   * @throws Никогда — все ошибки в `Result`
   *
   * @remarks
   * Значение проходит те же инварианты, что и созданное в коде: строго
   * положительное, конечное, не `NaN`.
   *
   * @example
   * ```typescript
   * AssetPriceSerializer.fromJSON({ value: '78468.50' }); // Ok
   * AssetPriceSerializer.fromJSON({ value: '0' });        // Err: NOT_POSITIVE
   * AssetPriceSerializer.fromJSON([1, 2]);                // Err: invalid_json
   * ```
   */
  public static fromJSON(json: unknown): Result<AssetPrice, InvalidAssetPriceError> {
    return priceFromJSON(ASSET_PRICE_DOMAIN, json, AssetPriceSerializer.SERVICE_NAME);
  }

  /**
   * Сериализует цену актива в JSON.
   *
   * @param price - Цена актива
   * @returns `{ value: string }` без потери точности
   *
   * @example
   * ```typescript
   * AssetPriceSerializer.toJSON(price); // { value: "78376.356031481042173952" }
   * ```
   */
  public static toJSON(price: AssetPrice): AssetPriceJSON {
    return priceToJSON(price);
  }
}
