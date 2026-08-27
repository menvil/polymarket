/**
 * Форматирование цены актива для отображения.
 *
 * @remarks
 * Реализация общая для всех ценовых доменов (`shared/price/priceCodec`) — форматом
 * занимается `Decimal`, а не домен. Здесь только связывание с доменом цены
 * актива и его типом ошибки.
 *
 * Процентного представления тут НЕТ намеренно: у рынка предсказаний
 * `toPercentage` осмыслен (доля исхода `0.52` → «52%»), а для цены актива
 * дал бы «7846850%» — число без смысла.
 *
 * @example
 * ```typescript
 * AssetPriceFormatter.toFixed(price, 2); // Ok("78468.50")
 * ```
 */
import type { Result } from '@polymarket/result';
import type { InvalidAssetPriceError } from '@polymarket/errors';
import type { AssetPrice } from '../core/AssetPrice.js';
import { formatPriceFixed } from '../../shared/price/priceCodec.js';
import { ASSET_PRICE_DOMAIN } from '../facade/AssetPriceService.js';

export class AssetPriceFormatter {
  /** Имя сервиса в контексте ошибок. */
  private static readonly SERVICE_NAME = 'AssetPriceFormatter';

  /**
   * Форматирует цену с фиксированным числом знаков после запятой.
   *
   * @param price - Цена актива
   * @param decimals - Количество знаков (по умолчанию 2 — типичная точность
   *   котировки; для активов с мелким шагом передавай больше)
   * @returns Строка либо `InvalidAssetPriceError` при некорректном `decimals`
   * @throws Никогда — все ошибки в `Result`
   *
   * @example
   * ```typescript
   * AssetPriceFormatter.toFixed(price, 2); // Ok("78468.50")
   * AssetPriceFormatter.toFixed(price, -1); // Err
   * ```
   */
  public static toFixed(
    price: AssetPrice,
    decimals: number = 2,
  ): Result<string, InvalidAssetPriceError> {
    return formatPriceFixed(ASSET_PRICE_DOMAIN, price, decimals, AssetPriceFormatter.SERVICE_NAME);
  }
}
