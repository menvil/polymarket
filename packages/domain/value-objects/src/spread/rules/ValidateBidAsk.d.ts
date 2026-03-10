import { type Result } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import { Price } from '../../price/index.js';
/**
 * Валидация: bid должен быть <= ask
 *
 * @remarks
 * Atomic business rule для проверки корректности bid-ask пары.
 *
 * **Правило:**
 * - Bid — максимальная цена покупки
 * - Ask — минимальная цена продажи
 * - Bid не может превышать Ask (иначе кросс рынка)
 *
 * @example
 * ```typescript
 * const bid = Price.of(new Decimal(0.48));
 * const ask = Price.of(new Decimal(0.52));
 * const result = ValidateBidAsk.check(bid, ask);
 * // result.ok === true
 *
 * const invalidBid = Price.of(new Decimal(0.60));
 * const invalidResult = ValidateBidAsk.check(invalidBid, ask);
 * // invalidResult.ok === false
 * ```
 */
export declare class ValidateBidAsk {
    /**
     * Проверить что bid <= ask
     *
     * @param bid - Bid price
     * @param ask - Ask price
     * @returns Ok если валидны, Err если bid > ask
     */
    static check(bid: Price, ask: Price): Result<void, InvalidSpreadError>;
}
//# sourceMappingURL=ValidateBidAsk.d.ts.map