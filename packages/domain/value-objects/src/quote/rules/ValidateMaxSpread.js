import { Ok, Err } from '@polymarket/result';
import { InvalidQuoteError, ErrorSource } from '@polymarket/errors';
import { QuoteErrorReason } from '../errors/QuoteErrorReason.js';
/**
 * Проверяет максимальную ширину спреда
 *
 * @remarks
 * Используется для обнаружения аномально широких спредов.
 *
 * Причины слишком широкого spread:
 * - Ошибка в расчётах
 * - Манипуляция рынком
 * - Экстремальная волатильность
 * - Проблемы с данными
 *
 * @example
 * ```typescript
 * const spread = new Decimal(0.15); // 15%
 * const maxSpread = new Decimal(0.10); // 10%
 *
 * const result = ValidateMaxSpread.check(spread, maxSpread);
 * // result.ok === false
 * // spread превышает максимальный
 * ```
 */
export class ValidateMaxSpread {
    /**
     * Проверяет максимальный spread
     *
     * @param spread - Ширина спреда
     * @param maxSpread - Максимально допустимый spread
     * @returns Result с void или InvalidQuoteError
     *
     * @example
     * ```typescript
     * const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());
     * const spread = quote.spreadWidthOrZero();
     *
     * const result = ValidateMaxSpread.check(spread, new Decimal(0.10));
     * if (!result.ok) {
     *   console.error('Spread too wide - possible error or manipulation');
     * }
     * ```
     */
    static check(spread, maxSpread) {
        if (spread.greaterThan(maxSpread)) {
            return Err(new InvalidQuoteError(`Spread ${spread} exceeds maximum ${maxSpread}`, {
                context: {
                    source: ErrorSource.RULE_VALIDATION,
                    reason: QuoteErrorReason.SPREAD_TOO_WIDE,
                    spread: spread.toNumber(),
                    maxSpread: maxSpread.toNumber()
                }
            }));
        }
        return Ok(undefined);
    }
}
//# sourceMappingURL=ValidateMaxSpread.js.map