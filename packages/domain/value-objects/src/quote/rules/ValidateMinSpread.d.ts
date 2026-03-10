import { Result } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import Decimal from 'decimal.js';
/**
 * Проверяет минимальную ширину спреда
 *
 * @remarks
 * Используется для предотвращения too tight spreads.
 *
 * Это бизнес-правило для market making:
 * - Слишком узкий spread может указывать на ошибку
 * - Или на манипуляцию рынком
 * - Минимальный spread зависит от рынка и волатильности
 *
 * @example
 * ```typescript
 * const spread = new Decimal(0.0005); // 0.05%
 * const minSpread = new Decimal(0.001); // 0.1%
 *
 * const result = ValidateMinSpread.check(spread, minSpread);
 * // result.ok === false
 * // spread меньше минимального
 * ```
 */
export declare class ValidateMinSpread {
    /**
     * Проверяет минимальный spread
     *
     * @param spread - Ширина спреда
     * @param minSpread - Минимально допустимый spread
     * @returns Result с void или InvalidQuoteError
     *
     * @example
     * ```typescript
     * const quote = Quote.of(bid, ask, bidSize, askSize, Date.now());
     * const spread = quote.spreadWidthOrZero();
     *
     * const result = ValidateMinSpread.check(spread, new Decimal(0.001));
     * if (!result.ok) {
     *   console.error('Spread too narrow');
     * }
     * ```
     */
    static check(spread: Decimal, minSpread: Decimal): Result<void, InvalidQuoteError>;
}
//# sourceMappingURL=ValidateMinSpread.d.ts.map