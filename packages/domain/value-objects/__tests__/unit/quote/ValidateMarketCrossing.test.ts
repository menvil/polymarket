import { describe, it, expect } from '@jest/globals';
import { ValidateMarketCrossing } from '../../../src/quote/rules/ValidateMarketCrossing.js';
import { Quote } from '../../../src/quote/core/Quote.js';
import { Price } from '../../../src/price/core/Price.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { QuoteErrorReason } from '../../../src/quote/errors/QuoteErrorReason.js';

describe('ValidateMarketCrossing', () => {
  describe('checkQuote()', () => {
    it('returns Ok для нормальной котировки (не пересекает)', () => {
      const quote = Quote.of(
        Price.of(0.48), // bid
        Price.of(0.52), // ask
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(true);
    });

    it('returns Err когда bid >= orderbook ask (пересекает)', () => {
      const quote = Quote.of(
        Price.of(0.51), // наш bid
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51); // наш bid >= orderbook ask

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
        expect(result.error.context?.side).toBe('bid');
        expect(result.error.context?.quoteBid).toBe(0.51);
        expect(result.error.context?.orderbookAsk).toBe(0.51);
      }
    });

    it('returns Err когда ask <= orderbook bid (пересекает)', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.50), // наш ask
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50); // наш ask <= orderbook bid
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
        expect(result.error.context?.side).toBe('ask');
        expect(result.error.context?.quoteAsk).toBe(0.50);
        expect(result.error.context?.orderbookBid).toBe(0.50);
      }
    });

    it('returns Ok когда наш bid null (bid-only check пропускается)', () => {
      const quote = Quote.of(
        null, // bid null
        Price.of(0.52),
        Quantity.ZERO,
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(true);
    });

    it('returns Ok когда orderbook ask null (bid-only check пропускается)', () => {
      const quote = Quote.of(
        Price.of(0.51),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50);

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, null);

      expect(result.ok).toBe(true);
    });

    it('returns Ok когда наш ask null (ask-only check пропускается)', () => {
      const quote = Quote.of(
        Price.of(0.48),
        null, // ask null
        Quantity.of(100),
        Quantity.ZERO,
        Date.now()
      );

      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(true);
    });

    it('returns Ok когда orderbook bid null (ask-only check пропускается)', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.50),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.checkQuote(quote, null, orderbookAsk);

      expect(result.ok).toBe(true);
    });
  });

  describe('crossesMarket()', () => {
    it('returns true когда пересекает', () => {
      const quote = Quote.of(
        Price.of(0.51), // наш bid
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51); // наш bid >= orderbook ask

      const crosses = ValidateMarketCrossing.crossesMarket(quote, orderbookBid, orderbookAsk);

      expect(crosses).toBe(true);
    });

    it('returns false когда не пересекает', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      const crosses = ValidateMarketCrossing.crossesMarket(quote, orderbookBid, orderbookAsk);

      expect(crosses).toBe(false);
    });
  });

  describe('check() - low-level API', () => {
    it('works с отдельными bid/ask вместо Quote', () => {
      const quoteBid = Price.of(0.51);
      const quoteAsk = Price.of(0.52);
      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51); // quoteBid >= orderbookAsk

      const result = ValidateMarketCrossing.check(quoteBid, quoteAsk, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
      }
    });
  });
});
