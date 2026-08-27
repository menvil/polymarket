import Decimal from 'decimal.js';
import { ValidateBidAsk } from '../../../../src/spread/rules/ValidateBidAsk.js';
import { OutcomePrice } from '../../../../src/outcome-price/index.js';
import { SpreadErrorReason } from '../../../../src/spread/errors/SpreadErrorReason.js';

describe('ValidateBidAsk', () => {
  describe('check()', () => {
    it('should return Ok when bid < ask', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));

      const result = ValidateBidAsk.check(bid, ask);

      expect(result.ok).toBe(true);
    });

    it('should return Ok when bid = ask (zero width spread)', () => {
      const price = OutcomePrice.of(new Decimal(0.50));

      const result = ValidateBidAsk.check(price, price);

      expect(result.ok).toBe(true);
    });

    it('should return Err when bid > ask', () => {
      const bid = OutcomePrice.of(new Decimal(0.60));
      const ask = OutcomePrice.of(new Decimal(0.50));

      const result = ValidateBidAsk.check(bid, ask);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.bid).toBe('0.6');
        expect(result.error.context?.ask).toBe('0.5');
        expect(result.error.context?.reason).toBe(SpreadErrorReason.BID_GREATER_THAN_ASK);
      }
    });

    it('should return Err with correct error message when bid > ask', () => {
      const bid = OutcomePrice.of(new Decimal(0.65));
      const ask = OutcomePrice.of(new Decimal(0.55));

      const result = ValidateBidAsk.check(bid, ask);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('bid 0.65');
        expect(result.error.message).toContain('ask 0.55');
        expect(result.error.message).toContain('cannot be greater than');
      }
    });

    it('should handle edge case: bid at MIN_PRICE and ask at MAX_PRICE', () => {
      const bid = OutcomePrice.of(new Decimal(0.0001));
      const ask = OutcomePrice.of(new Decimal(0.9999));

      const result = ValidateBidAsk.check(bid, ask);

      expect(result.ok).toBe(true);
    });

    it('should handle edge case: very small difference between bid and ask', () => {
      const bid = OutcomePrice.of(new Decimal(0.5000));
      const ask = OutcomePrice.of(new Decimal(0.5001));

      const result = ValidateBidAsk.check(bid, ask);

      expect(result.ok).toBe(true);
    });
  });
});
