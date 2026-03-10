import { Ok, Err } from '@polymarket/result';
import { InvalidQuoteError, ErrorSource } from '@polymarket/errors';
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
    static check(quoteBid, quoteAsk, orderbookBid, orderbookAsk) {
        // Проверяем пересечение bid стороны
        if (quoteBid !== null && orderbookAsk !== null) {
            if (quoteBid.value().greaterThanOrEqualTo(orderbookAsk.value())) {
                return Err(new InvalidQuoteError(`Quote bid ${quoteBid.value()} would cross orderbook ask ${orderbookAsk.value()}`, {
                    context: {
                        source: ErrorSource.RULE_VALIDATION,
                        reason: QuoteErrorReason.MARKET_CROSSING,
                        quoteBid: quoteBid.value().toNumber(),
                        orderbookAsk: orderbookAsk.value().toNumber(),
                        side: 'bid'
                    }
                }));
            }
        }
        // Проверяем пересечение ask стороны
        if (quoteAsk !== null && orderbookBid !== null) {
            if (quoteAsk.value().lessThanOrEqualTo(orderbookBid.value())) {
                return Err(new InvalidQuoteError(`Quote ask ${quoteAsk.value()} would cross orderbook bid ${orderbookBid.value()}`, {
                    context: {
                        source: ErrorSource.RULE_VALIDATION,
                        reason: QuoteErrorReason.MARKET_CROSSING,
                        quoteAsk: quoteAsk.value().toNumber(),
                        orderbookBid: orderbookBid.value().toNumber(),
                        side: 'ask'
                    }
                }));
            }
        }
        return Ok(undefined);
    }
    /**
     * Проверяет отсутствие market crossing для Quote объекта
     *
     * @remarks
     * Удобный метод который принимает Quote вместо отдельных bid/ask.
     * Делегирует в check() для реализации.
     *
     * @param quote - Котировка для проверки
     * @param orderbookBid - Лучший bid в order book
     * @param orderbookAsk - Лучший ask в order book
     * @returns Result с void или InvalidQuoteError
     *
     * @example
     * ```typescript
     * const quote = Quote.of(myBid, myAsk, bidSize, askSize, Date.now());
     *
     * const result = ValidateMarketCrossing.checkQuote(
     *   quote,
     *   Price.of(0.50), // orderbook bid
     *   Price.of(0.51)  // orderbook ask
     * );
     *
     * if (!result.ok) {
     *   console.error('Quote would cross the market!');
     * }
     * ```
     */
    static checkQuote(quote, orderbookBid, orderbookAsk) {
        return this.check(quote.bid(), quote.ask(), orderbookBid, orderbookAsk);
    }
    /**
     * Проверяет, пересекает ли котировка market (boolean версия)
     *
     * @remarks
     * Утилита для простой проверки без Result.
     * Возвращает true если пересекает, false если нет.
     *
     * @param quote - Котировка для проверки
     * @param orderbookBid - Лучший bid в order book
     * @param orderbookAsk - Лучший ask в order book
     * @returns true если пересекает, false если нет
     *
     * @example
     * ```typescript
     * const quote = Quote.of(...);
     * const crosses = ValidateMarketCrossing.crossesMarket(
     *   quote,
     *   Price.of(0.50),
     *   Price.of(0.51)
     * );
     * if (crosses) {
     *   console.log('Quote would cross the market!');
     * }
     * ```
     */
    static crossesMarket(quote, orderbookBid, orderbookAsk) {
        const result = this.checkQuote(quote, orderbookBid, orderbookAsk);
        return !result.ok;
    }
}
//# sourceMappingURL=ValidateMarketCrossing.js.map