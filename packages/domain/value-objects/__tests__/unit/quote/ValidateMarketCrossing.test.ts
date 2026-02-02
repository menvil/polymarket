import { describe, it, expect } from '@jest/globals';
import { ValidateMarketCrossing } from '../../../src/quote/rules/ValidateMarketCrossing.js';
import { Price } from '../../../src/price/core/Price.js';
import { QuoteErrorReason } from '../../../src/quote/errors/QuoteErrorReason.js';

describe('ValidateMarketCrossing', () => {
  describe('check()', () => {
    it('проходит для нормальной котировки без crossing', () => {
      const quoteBid = Price.of(0.48);
      const quoteAsk = Price.of(0.52);
      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.check(
        quoteBid,
        quoteAsk,
        orderbookBid,
        orderbookAsk
      );

      expect(result.ok).toBe(true);
    });

    it('проходит когда quote bid < orderbook ask', () => {
      const quoteBid = Price.of(0.50);
      const quoteAsk = Price.of(0.52);
      const orderbookBid = Price.of(0.49);
      const orderbookAsk = Price.of(0.51); // quoteBid < orderbookAsk

      const result = ValidateMarketCrossing.check(
        quoteBid,
        quoteAsk,
        orderbookBid,
        orderbookAsk
      );

      expect(result.ok).toBe(true);
    });

    it('проходит когда quote ask > orderbook bid', () => {
      const quoteBid = Price.of(0.48);
      const quoteAsk = Price.of(0.52); // quoteAsk > orderbookBid
      const orderbookBid = Price.of(0.51);
      const orderbookAsk = Price.of(0.53);

      const result = ValidateMarketCrossing.check(
        quoteBid,
        quoteAsk,
        orderbookBid,
        orderbookAsk
      );

      expect(result.ok).toBe(true);
    });

    it('фэйлится когда quote bid >= orderbook ask (crossing)', () => {
      const quoteBid = Price.of(0.51); // crossing!
      const quoteAsk = Price.of(0.52);
      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.check(
        quoteBid,
        quoteAsk,
        orderbookBid,
        orderbookAsk
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
        expect(result.error.context?.quoteBid).toBe(0.51);
        expect(result.error.context?.orderbookAsk).toBe(0.51);
        expect(result.error.context?.side).toBe('bid');
      }
    });

    it('фэйлится когда quote bid > orderbook ask (сильный crossing)', () => {
      const quoteBid = Price.of(0.52); // сильный crossing
      const quoteAsk = Price.of(0.53);
      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.check(
        quoteBid,
        quoteAsk,
        orderbookBid,
        orderbookAsk
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
        expect(result.error.context?.side).toBe('bid');
      }
    });

    it('фэйлится когда quote ask <= orderbook bid (crossing)', () => {
      const quoteBid = Price.of(0.48);
      const quoteAsk = Price.of(0.50); // crossing!
      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.check(
        quoteBid,
        quoteAsk,
        orderbookBid,
        orderbookAsk
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
        expect(result.error.context?.quoteAsk).toBe(0.50);
        expect(result.error.context?.orderbookBid).toBe(0.50);
        expect(result.error.context?.side).toBe('ask');
      }
    });

    it('фэйлится когда quote ask < orderbook bid (сильный crossing)', () => {
      const quoteBid = Price.of(0.48);
      const quoteAsk = Price.of(0.49); // сильный crossing
      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.check(
        quoteBid,
        quoteAsk,
        orderbookBid,
        orderbookAsk
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
        expect(result.error.context?.side).toBe('ask');
      }
    });

    it('проходит когда quote bid null', () => {
      const quoteAsk = Price.of(0.52);
      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.check(
        null,
        quoteAsk,
        orderbookBid,
        orderbookAsk
      );

      expect(result.ok).toBe(true);
    });

    it('проходит когда quote ask null', () => {
      const quoteBid = Price.of(0.50);
      const orderbookBid = Price.of(0.49);
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.check(
        quoteBid,
        null,
        orderbookBid,
        orderbookAsk
      );

      expect(result.ok).toBe(true);
    });

    it('проходит когда orderbook ask null', () => {
      const quoteBid = Price.of(0.51);
      const quoteAsk = Price.of(0.52);
      const orderbookBid = Price.of(0.50);

      const result = ValidateMarketCrossing.check(
        quoteBid,
        quoteAsk,
        orderbookBid,
        null
      );

      expect(result.ok).toBe(true);
    });

    it('проходит когда orderbook bid null', () => {
      const quoteBid = Price.of(0.48);
      const quoteAsk = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      const result = ValidateMarketCrossing.check(
        quoteBid,
        quoteAsk,
        null,
        orderbookAsk
      );

      expect(result.ok).toBe(true);
    });
  });
});
