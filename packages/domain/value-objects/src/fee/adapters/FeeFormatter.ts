/**
 * Formatter для Fee
 *
 * @remarks
 * Форматирует Fee для отображения в UI.
 *
 * @example
 * ```typescript
 * import { FeeFormatter } from '@polymarket/value-objects';
 *
 * const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
 *
 * FeeFormatter.toDisplay(fee);      // "0.10 USDC"
 * FeeFormatter.toAmount(fee);       // "0.10"
 * FeeFormatter.toAssetSymbol(fee);  // "USDC"
 * ```
 */

import { Fee } from '../core/Fee.js';

export class FeeFormatter {
  /**
   * Форматировать Fee для отображения (amount + asset symbol)
   *
   * @param fee - Fee для форматирования
   * @returns Строка вида "0.10 USDC" или "0.10 TOKEN:..."
   *
   * @example
   * ```typescript
   * const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
   * console.log(FeeFormatter.toDisplay(fee));
   * // "0.10 USDC"
   * ```
   */
  public static toDisplay(fee: Fee): string {
    const amount = fee.quantity.amount().toNumber();
    const symbol = this.toAssetSymbol(fee);
    return `${amount} ${symbol}`;
  }

  /**
   * Форматировать только amount
   *
   * @param fee - Fee для форматирования
   * @returns Строка с числовым значением
   *
   * @example
   * ```typescript
   * const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
   * console.log(FeeFormatter.toAmount(fee));
   * // "0.10"
   * ```
   */
  public static toAmount(fee: Fee): string {
    return String(fee.quantity.amount().toNumber());
  }

  /**
   * Получить символ актива
   *
   * @param fee - Fee для форматирования
   * @returns Символ актива (для Currency - название валюты, для Token - сокращённый ID)
   *
   * @example
   * ```typescript
   * const usdcFee = Fee.zero(AssetIdHelpers.USDC);
   * console.log(FeeFormatter.toAssetSymbol(usdcFee));
   * // "USDC"
   * ```
   */
  public static toAssetSymbol(fee: Fee): string {
    const asset = fee.asset;

    if (asset.type === 'CURRENCY') {
      return asset.currency;
    }

    // Для outcome token используем короткий формат
    const conditionId = asset.conditionRef.conditionId;
    const shortId = conditionId.slice(0, 6) + '...' + conditionId.slice(-4);
    return `${asset.outcomeKey}:${shortId}`;
  }

  /**
   * Форматировать Fee для логирования
   *
   * @param fee - Fee для форматирования
   * @returns Подробная строка для логов
   *
   * @example
   * ```typescript
   * const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
   * console.log(FeeFormatter.toLogString(fee));
   * // "Fee(CURRENCY:USDC, 0.10)"
   * ```
   */
  public static toLogString(fee: Fee): string {
    return fee.toString();
  }

  /**
   * Форматировать как процент (для отображения fee rate)
   *
   * @param fee - Fee (обычно в диапазоне 0-1)
   * @param precision - Количество знаков после запятой (по умолчанию 2)
   * @returns Строка вида "0.10%"
   *
   * @remarks
   * Предполагает что fee.quantity.amount() уже представляет процент
   * (например 0.001 = 0.1%).
   *
   * @example
   * ```typescript
   * const feeRate = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.001'))));
   * console.log(FeeFormatter.toPercent(feeRate));
   * // "0.10%"
   * ```
   */
  public static toPercent(fee: Fee, precision: number = 2): string {
    const percent = fee.quantity.amount().toNumber() * 100;
    return `${percent.toFixed(precision)}%`;
  }
}
