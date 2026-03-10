import Decimal from 'decimal.js';
import { assetIdToString } from '@polymarket/ids';
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
export class AssetQuantityFormatter {
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
    static toString(assetQty) {
        const amount = assetQty.amount().value().toString();
        const assetStr = assetIdToString(assetQty.asset());
        return `AssetQuantity[amount=${amount}, asset=${assetStr}]`;
    }
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
    static toDisplayString(assetQty) {
        const amount = assetQty.amount().value().toString();
        const asset = assetQty.asset();
        if (asset.type === 'CURRENCY') {
            return `${amount} ${asset.currency}`;
        }
        if (asset.type === 'POLYMARKET_CTF_TOKEN') {
            const shortId = asset.tokenId.length > 12
                ? `${asset.tokenId.slice(0, 6)}...${asset.tokenId.slice(-4)}`
                : asset.tokenId;
            return `${amount} CTF[${shortId}]`;
        }
        // OUTCOME_TOKEN
        const ref = asset.conditionRef;
        const outcomeKey = asset.outcomeKey;
        // Сокращаем conditionId для читаемости
        const shortConditionId = ref.conditionId.length > 10
            ? `${ref.conditionId.slice(0, 6)}...${ref.conditionId.slice(-4)}`
            : ref.conditionId;
        return `${amount} ${outcomeKey} (${ref.protocolId}:${ref.chainId}:${shortConditionId})`;
    }
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
    static toShortString(assetQty) {
        const amount = assetQty.amount().value().toString();
        const asset = assetQty.asset();
        if (asset.type === 'CURRENCY') {
            return `${amount} ${asset.currency}`;
        }
        if (asset.type === 'POLYMARKET_CTF_TOKEN') {
            const shortId = asset.tokenId.length > 12
                ? `${asset.tokenId.slice(0, 6)}...${asset.tokenId.slice(-4)}`
                : asset.tokenId;
            return `${amount} CTF[${shortId}]`;
        }
        // OUTCOME_TOKEN
        return `${amount} ${asset.outcomeKey}`;
    }
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
    static toVerboseString(assetQty) {
        const amount = assetQty.amount().value().toString();
        const asset = assetQty.asset();
        let assetVerbose;
        if (asset.type === 'CURRENCY') {
            assetVerbose = `Currency[${asset.currency}]`;
        }
        else if (asset.type === 'POLYMARKET_CTF_TOKEN') {
            assetVerbose = `PolymarketCtfToken[tokenId=${asset.tokenId}]`;
        }
        else {
            // OUTCOME_TOKEN
            const ref = asset.conditionRef;
            const outcomeKey = asset.outcomeKey;
            const condRefStr = `${ref.kind}:${ref.protocolId}:${ref.chainId}:${ref.conditionId}`;
            assetVerbose = `OutcomeToken[outcomeKey=${outcomeKey}, condition=${condRefStr}]`;
        }
        return `AssetQuantity[amount=${amount}, asset=${assetVerbose}]`;
    }
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
    static toFixedString(assetQty, decimalPlaces = 2) {
        const safeDecimals = Decimal.max(0, Decimal.min(100, new Decimal(decimalPlaces).floor())).toNumber();
        const amount = assetQty.amount().value().toFixed(safeDecimals);
        const asset = assetQty.asset();
        if (asset.type === 'CURRENCY') {
            return `${amount} ${asset.currency}`;
        }
        if (asset.type === 'POLYMARKET_CTF_TOKEN') {
            const shortId = asset.tokenId.length > 12
                ? `${asset.tokenId.slice(0, 6)}...${asset.tokenId.slice(-4)}`
                : asset.tokenId;
            return `${amount} CTF[${shortId}]`;
        }
        // OUTCOME_TOKEN
        return `${amount} ${asset.outcomeKey}`;
    }
}
//# sourceMappingURL=AssetQuantityFormatter.js.map