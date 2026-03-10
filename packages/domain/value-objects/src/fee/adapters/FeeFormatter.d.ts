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
export declare class FeeFormatter {
    /**
     * Форматировать Fee для отображения (amount + asset symbol)
     *
     * @param fee - Fee для форматирования
     * @returns Строка вида "0.1 USDC" или "0.1 TOKEN:..." (полная precision сохраняется)
     *
     * @remarks
     * Использует Decimal.toString() для сохранения полной точности.
     * Не использует toNumber() чтобы избежать потери precision для больших чисел.
     *
     * @example
     * ```typescript
     * const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
     * console.log(FeeFormatter.toDisplay(fee));
     * // "0.1 USDC"
     *
     * // Precision сохраняется для больших чисел
     * const bigFee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('123456789.123456789012345'))));
     * console.log(FeeFormatter.toDisplay(bigFee));
     * // "123456789.123456789012345 USDC"
     * ```
     */
    static toDisplay(fee: Fee): string;
    /**
     * Форматировать только amount
     *
     * @param fee - Fee для форматирования
     * @returns Строка с числовым значением (полная precision сохраняется)
     *
     * @remarks
     * Использует Decimal.toString() для сохранения полной точности.
     * Не использует toNumber() чтобы избежать потери precision для больших чисел.
     *
     * @example
     * ```typescript
     * const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
     * console.log(FeeFormatter.toAmount(fee));
     * // "0.1"
     *
     * // Precision сохраняется для больших чисел
     * const bigFee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('123456789.123456789012345'))));
     * console.log(FeeFormatter.toAmount(bigFee));
     * // "123456789.123456789012345"
     * ```
     */
    static toAmount(fee: Fee): string;
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
    static toAssetSymbol(fee: Fee): string;
    /**
     * Форматировать Fee для отладки
     *
     * @param fee - Fee для форматирования
     * @returns Подробная строка для debugging (включает тип актива и amount)
     *
     * @remarks
     * Использует Fee.toString() который возвращает полную debug representation.
     * Полезно для логирования и отладки.
     *
     * @example
     * ```typescript
     * const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
     * console.log(FeeFormatter.toDebugString(fee));
     * // "Fee(CURRENCY:USDC, 0.1)"
     * ```
     */
    static toDebugString(fee: Fee): string;
}
//# sourceMappingURL=FeeFormatter.d.ts.map