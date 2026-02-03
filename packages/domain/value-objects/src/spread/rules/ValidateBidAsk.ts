import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import { Price } from '../../price/index.js';
import { SpreadErrorReason } from '../core/SpreadErrorReason.js';

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
export class ValidateBidAsk {
  /**
   * Проверить что bid <= ask
   *
   * @param bid - Bid price
   * @param ask - Ask price
   * @returns Ok если валидны, Err если bid > ask
   */
  public static check(bid: Price, ask: Price): Result<void, InvalidSpreadError> {
    if (bid.value().greaterThan(ask.value())) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Invalid bid-ask: bid ${ctx.bid} cannot be greater than ask ${ctx.ask}`,
          {
            context: {
              bid: bid.value().toString(),
              ask: ask.value().toString(),
              reason: SpreadErrorReason.BID_GREATER_THAN_ASK
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
