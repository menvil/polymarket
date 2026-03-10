import { Result } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import Decimal from 'decimal.js';
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
export declare class ValidateMaxSpread {
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
    static check(spread: Decimal, maxSpread: Decimal): Result<void, InvalidQuoteError>;
}
//# sourceMappingURL=ValidateMaxSpread.d.ts.map