import { AssetQuantity } from '../core/AssetQuantity.js';
/**
 * Форматтер для AssetQuantity
 *
 * @remarks
 * Предоставляет методы для форматирования AssetQuantity в строки
 * для UI и логирования.
 *
 * Все методы безопасны и не бросают исключений.
 * Автоматически определяет тип актива (Currency или OutcomeToken) и форматирует соответственно.
 *
 * @example
 * ```typescript
 * import { AssetQuantityService, AssetQuantityFormatter } from '@polymarket/value-objects/asset-quantity';
 * import { BinaryOutcome } from '@polymarket/ids';
 *
 * // USDC
 * const usdcQty = expectOk(AssetQuantityService.createUsdc(100.5));
 * const display = AssetQuantityFormatter.toDisplayString(usdcQty);
 * console.log(display);  // "100.5 USDC"
 *
 * // OutcomeToken
 * const tokenQty = expectOk(AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50));
 * const display2 = AssetQuantityFormatter.toDisplayString(tokenQty);
 * console.log(display2);  // "50 UP (POLYMARKET_CTF:137:0xabc...)"
 * ```
 */
export declare class AssetQuantityFormatter {
    /**
     * Форматирует AssetQuantity как полную строку с деталями
     *
     * @remarks
     * Включает amount и полную информацию об asset.
     * Используется для логирования и диагностики.
     *
     * @param assetQty - AssetQuantity для форматирования
     * @returns Отформатированная строка
     *
     * @example
     * ```typescript
     * const usdcQty = expectOk(AssetQuantityService.createUsdc(100.5));
     * const str = AssetQuantityFormatter.toString(usdcQty);
     * // → "AssetQuantity[amount=100.5, asset=CURRENCY:USDC]"
     *
     * const tokenQty = expectOk(AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50));
     * const str2 = AssetQuantityFormatter.toString(tokenQty);
     * // → "AssetQuantity[amount=50, asset=OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc...:UP]"
     * ```
     */
    static toString(assetQty: AssetQuantity): string;
    /**
     * Форматирует AssetQuantity для отображения в UI
     *
     * @remarks
     * Более читаемый формат с amount и кратким описанием asset.
     * Используется для UI элементов.
     *
     * Для Currency: "100.5 USDC"
     * Для OutcomeToken: "50 UP (POLYMARKET_CTF:137:0xabc...)"
     *
     * @param assetQty - AssetQuantity для форматирования
     * @returns Human-readable строка
     *
     * @example
     * ```typescript
     * const usdcQty = expectOk(AssetQuantityService.createUsdc(100.5));
     * const display = AssetQuantityFormatter.toDisplayString(usdcQty);
     * // → "100.5 USDC"
     *
     * const tokenQty = expectOk(AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50));
     * const display2 = AssetQuantityFormatter.toDisplayString(tokenQty);
     * // → "50 UP (POLYMARKET_CTF:137:0xabc...)"
     * ```
     */
    static toDisplayString(assetQty: AssetQuantity): string;
    /**
     * Форматирует AssetQuantity в краткую строку
     *
     * @remarks
     * Минимальное представление - amount + asset name/key.
     * Используется для компактного отображения в таблицах и списках.
     *
     * Для Currency: "100.5 USDC"
     * Для OutcomeToken: "50 UP"
     *
     * @param assetQty - AssetQuantity для форматирования
     * @returns Краткая строка
     *
     * @example
     * ```typescript
     * const usdcQty = expectOk(AssetQuantityService.createUsdc(100.5));
     * const short = AssetQuantityFormatter.toShortString(usdcQty);
     * // → "100.5 USDC"
     *
     * const tokenQty = expectOk(AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50));
     * const short2 = AssetQuantityFormatter.toShortString(tokenQty);
     * // → "50 UP"
     * ```
     */
    static toShortString(assetQty: AssetQuantity): string;
    /**
     * Форматирует AssetQuantity с полной информацией
     *
     * @remarks
     * Включает все детали asset и amount для debug/logging.
     * Используется для подробного логирования.
     *
     * @param assetQty - AssetQuantity для форматирования
     * @returns Детальная строка с полной информацией
     *
     * @example
     * ```typescript
     * const usdcQty = expectOk(AssetQuantityService.createUsdc(100.5));
     * const verbose = AssetQuantityFormatter.toVerboseString(usdcQty);
     * // → "AssetQuantity[amount=100.5, asset=Currency[USDC]]"
     *
     * const tokenQty = expectOk(AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50));
     * const verbose2 = AssetQuantityFormatter.toVerboseString(tokenQty);
     * // → "AssetQuantity[amount=50, asset=OutcomeToken[outcomeKey=UP, condition=ONCHAIN:POLYMARKET_CTF:137:0xabc...]]"
     * ```
     */
    static toVerboseString(assetQty: AssetQuantity): string;
    /**
     * Форматирует amount с указанным числом десятичных знаков
     *
     * @remarks
     * Удобный метод для форматирования amount с округлением.
     * Используется для отображения в UI с фиксированной точностью.
     *
     * @param assetQty - AssetQuantity для форматирования
     * @param decimalPlaces - Количество десятичных знаков (по умолчанию 2)
     * @returns Отформатированная строка с округленным amount
     *
     * @example
     * ```typescript
     * const usdcQty = expectOk(AssetQuantityService.createUsdc(100.5));
     * const formatted = AssetQuantityFormatter.toFixedString(usdcQty, 2);
     * // → "100.50 USDC"
     *
     * const tokenQty = expectOk(AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50.12345));
     * const formatted2 = AssetQuantityFormatter.toFixedString(tokenQty, 3);
     * // → "50.123 UP"
     * ```
     */
    static toFixedString(assetQty: AssetQuantity, decimalPlaces?: number): string;
}
//# sourceMappingURL=AssetQuantityFormatter.d.ts.map