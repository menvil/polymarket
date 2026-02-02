import Decimal from 'decimal.js';
import { Spread, SpreadInvariantViolation, SpreadErrorReason } from '../../../../src/spread/core/index.js';
import { Price } from '../../../../src/price/index.js';

describe('Spread Core', () => {
  describe('Spread.of()', () => {
    it('should create valid spread when bid <= ask', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));

      const spread = Spread.of(bid, ask);

      expect(spread.bid()).toBe(bid);
      expect(spread.ask()).toBe(ask);
    });

    it('should throw SpreadInvariantViolation when bid > ask', () => {
      const bid = Price.of(new Decimal(0.60));
      const ask = Price.of(new Decimal(0.50));

      expect(() => Spread.of(bid, ask)).toThrow(SpreadInvariantViolation);
      expect(() => Spread.of(bid, ask)).toThrow('Bid 0.6 cannot be greater than ask 0.5');
    });

    it('should have BID_GREATER_THAN_ASK reason when bid > ask', () => {
      const bid = Price.of(new Decimal(0.60));
      const ask = Price.of(new Decimal(0.50));

      try {
        Spread.of(bid, ask);
        fail('Expected SpreadInvariantViolation');
      } catch (error) {
        expect(error).toBeInstanceOf(SpreadInvariantViolation);
        if (error instanceof SpreadInvariantViolation) {
          expect(error.reason).toBe(SpreadErrorReason.BID_GREATER_THAN_ASK);
        }
      }
    });
  });

  describe('Spread.zero()', () => {
    it('should create spread with zero width', () => {
      const price = Price.of(new Decimal(0.50));

      const spread = Spread.zero(price);

      expect(spread.bid()).toBe(price);
      expect(spread.ask()).toBe(price);
      expect(spread.width().toNumber()).toBe(0);
      expect(spread.isZeroWidth()).toBe(true);
    });
  });

  describe('width()', () => {
    it('should calculate spread width correctly', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const width = spread.width();

      expect(width.toNumber()).toBe(0.04);
    });
  });

  describe('midpoint()', () => {
    it('should calculate midpoint correctly', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const midpoint = spread.midpoint();

      expect(midpoint.value().toNumber()).toBe(0.50);
    });
  });

  describe('widthPercentage()', () => {
    it('should calculate width percentage correctly', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const widthPercentage = spread.widthPercentage();

      // (0.04 / 0.50) * 100 = 8%
      expect(widthPercentage.toNumber()).toBe(8);
    });

    it('should return 0 when midpoint is zero', () => {
      // Edge case: if somehow midpoint is zero (shouldn't happen with valid Prices)
      // This is a defensive programming test
      const bid = Price.of(new Decimal(0.0001));
      const ask = Price.of(new Decimal(0.0001));
      const spread = Spread.of(bid, ask);

      const widthPercentage = spread.widthPercentage();

      expect(widthPercentage.toNumber()).toBe(0);
    });
  });

  describe('equals()', () => {
    it('should return true for equal spreads', () => {
      const bid1 = Price.of(new Decimal(0.48));
      const ask1 = Price.of(new Decimal(0.52));
      const spread1 = Spread.of(bid1, ask1);

      const bid2 = Price.of(new Decimal(0.48));
      const ask2 = Price.of(new Decimal(0.52));
      const spread2 = Spread.of(bid2, ask2);

      expect(spread1.equals(spread2)).toBe(true);
    });

    it('should return false for different spreads', () => {
      const bid1 = Price.of(new Decimal(0.48));
      const ask1 = Price.of(new Decimal(0.52));
      const spread1 = Spread.of(bid1, ask1);

      const bid2 = Price.of(new Decimal(0.45));
      const ask2 = Price.of(new Decimal(0.55));
      const spread2 = Spread.of(bid2, ask2);

      expect(spread1.equals(spread2)).toBe(false);
    });
  });

  describe('isZeroWidth()', () => {
    it('should return true for zero width spread', () => {
      const price = Price.of(new Decimal(0.50));
      const spread = Spread.zero(price);

      expect(spread.isZeroWidth()).toBe(true);
    });

    it('should return false for non-zero width spread', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      expect(spread.isZeroWidth()).toBe(false);
    });
  });

  describe('contains()', () => {
    it('should return true when price is within spread', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const priceInside = Price.of(new Decimal(0.50));

      expect(spread.contains(priceInside)).toBe(true);
    });

    it('should return true when price equals bid', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      expect(spread.contains(bid)).toBe(true);
    });

    it('should return true when price equals ask', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      expect(spread.contains(ask)).toBe(true);
    });

    it('should return false when price is below bid', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const priceBelow = Price.of(new Decimal(0.40));

      expect(spread.contains(priceBelow)).toBe(false);
    });

    it('should return false when price is above ask', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const priceAbove = Price.of(new Decimal(0.60));

      expect(spread.contains(priceAbove)).toBe(false);
    });
  });
});
