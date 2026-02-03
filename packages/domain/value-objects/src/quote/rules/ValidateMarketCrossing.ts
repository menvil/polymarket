import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Price } from '../../price/core/Price.js';
import { QuoteErrorReason } from '../errors/QuoteErrorReason.js';

/**
 * Проверяет, что котировка не пересекает market
 *
 * @remarks
 * Пересечение market (market crossing) происходит когда:
 * - Наш bid >= orderbook ask (мы готовы покупать по цене выше рынка)
 * - Наш ask <= orderbook bid (мы готовы продавать по цене ниже рынка)
 *
 * Это бизнес-правило для passive quotes:
 * - Для market making котировок crossing недопустим
 * - Для aggressive quotes crossing допустим (это taker orders)
 * - Crossing обычно приводит к немедленному исполнению
 *
 * @example
 * ```typescript
 * const myBid = Price.of(0.51);
 * const myAsk = Price.of(0.52);
 * const orderbookBid = Price.of(0.50);
 * const orderbookAsk = Price.of(0.51);
 *
 * const result = ValidateMarketCrossing.check(
 *   myBid, myAsk, orderbookBid, orderbookAsk
 * );
 * // result.ok === false
 * // myBid (0.51) >= orderbookAsk (0.51) - crossing!
 * ```
 */
export class ValidateMarketCrossing {
  /**
   * Проверяет отсутствие market crossing
   *
   * @param quoteBid - Наш bid
   * @param quoteAsk - Наш ask
   * @param orderbookBid - Лучший bid в order book
   * @param orderbookAsk - Лучший ask в order book
   * @returns Result с void или InvalidQuoteError
   *
   * @example
   * ```typescript
   * const quote = Quote.of(myBid, myAsk, bidSize, askSize, Date.now());
   *
   * const result = ValidateMarketCrossing.check(
   *   quote.bid(),
   *   quote.ask(),
   *   orderbookBid,
   *   orderbookAsk
   * );
   *
   * if (!result.ok) {
   *   console.error('Quote would cross the market!');
   *   console.error(result.error.context?.reason); // MARKET_CROSSING
   * }
   * ```
   */
  public static check(
    quoteBid: Price | null,
    quoteAsk: Price | null,
    orderbookBid: Price | null,
    orderbookAsk: Price | null
  ): Result<void, InvalidQuoteError> {
    // Проверяем пересечение bid стороны
    if (quoteBid !== null && orderbookAsk !== null) {
      if (quoteBid.value().greaterThanOrEqualTo(orderbookAsk.value())) {
        return Err(
          new InvalidQuoteError(
            `Quote bid ${quoteBid.value()} would cross orderbook ask ${orderbookAsk.value()}`,
            {
              context: {
                reason: QuoteErrorReason.MARKET_CROSSING,
                quoteBid: quoteBid.value().toNumber(),
                orderbookAsk: orderbookAsk.value().toNumber(),
                side: 'bid'
              }
            }
          )
        );
      }
    }

    // Проверяем пересечение ask стороны
    if (quoteAsk !== null && orderbookBid !== null) {
      if (quoteAsk.value().lessThanOrEqualTo(orderbookBid.value())) {
        return Err(
          new InvalidQuoteError(
            `Quote ask ${quoteAsk.value()} would cross orderbook bid ${orderbookBid.value()}`,
            {
              context: {
                reason: QuoteErrorReason.MARKET_CROSSING,
                quoteAsk: quoteAsk.value().toNumber(),
                orderbookBid: orderbookBid.value().toNumber(),
                side: 'ask'
              }
            }
          )
        );
      }
    }

    return Ok(undefined);
  }
}
