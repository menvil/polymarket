import { Ok, Err } from '@polymarket/result';
import { InvalidQuoteError, ErrorSource } from '@polymarket/errors';
import { QuoteErrorReason } from '../errors/QuoteErrorReason.js';
/**
 * Проверяет консистентность размеров котировки
 *
 * @remarks
 * Правило: если цена определена, размер должен быть > 0
 *
 * Это бизнес-правило, не инвариант Core:
 * - Core допускает bid с zero bidSize (технически валидно)
 * - Но для market making котировок это невалидно
 *
 * @example
 * ```typescript
 * const result = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);
 * if (!result.ok) {
 *   console.error('Invalid sizes');
 * }
 * ```
 */
export class ValidateQuoteSizes {
    /**
     * Проверяет соответствие размеров ценам
     *
     * @param bid - Цена покупки (может быть null)
     * @param bidSize - Объём покупки
     * @param ask - Цена продажи (может быть null)
     * @param askSize - Объём продажи
     * @returns Result с void или InvalidQuoteError
     *
     * @example
     * ```typescript
     * const bid = Price.of(0.50);
     * const bidSize = Quantity.ZERO; // ❌ invalid
     * const ask = Price.of(0.51);
     * const askSize = Quantity.of(100);
     *
     * const result = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);
     * // result.ok === false
     * // result.error.context.reason === QuoteErrorReason.BID_SIZE_MUST_BE_POSITIVE
     * ```
     */
    static check(bid, bidSize, ask, askSize) {
        // Если bid определён, bidSize должен быть положительным
        if (bid !== null && !bidSize.isPositive()) {
            return Err(new InvalidQuoteError('Bid size must be positive when bid is defined', {
                context: {
                    source: ErrorSource.RULE_VALIDATION,
                    reason: QuoteErrorReason.BID_SIZE_MUST_BE_POSITIVE,
                    bidValue: bid.value().toNumber(),
                    bidSize: bidSize.value().toNumber()
                }
            }));
        }
        // Если ask определён, askSize должен быть положительным
        if (ask !== null && !askSize.isPositive()) {
            return Err(new InvalidQuoteError('Ask size must be positive when ask is defined', {
                context: {
                    source: ErrorSource.RULE_VALIDATION,
                    reason: QuoteErrorReason.ASK_SIZE_MUST_BE_POSITIVE,
                    askValue: ask.value().toNumber(),
                    askSize: askSize.value().toNumber()
                }
            }));
        }
        return Ok(undefined);
    }
}
//# sourceMappingURL=ValidateQuoteSizes.js.map