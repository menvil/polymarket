import Decimal from 'decimal.js';
import { Spread, SpreadInvariantViolation } from '../../../../src/spread/core/index.js';
import { SpreadErrorReason } from '../../../../src/spread/errors/SpreadErrorReason.js';
import { OutcomePrice } from '../../../../src/outcome-price/index.js';

describe('Spread Core', () => {
  describe('Spread.of()', () => {
    it('should create valid spread when bid <= ask', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));

      const spread = Spread.of(bid, ask);

      expect(spread.bid()).toBe(bid);
      expect(spread.ask()).toBe(ask);
    });

    it('should throw SpreadInvariantViolation when bid > ask', () => {
      const bid = OutcomePrice.of(new Decimal(0.60));
      const ask = OutcomePrice.of(new Decimal(0.50));

      expect(() => Spread.of(bid, ask)).toThrow(SpreadInvariantViolation);
      expect(() => Spread.of(bid, ask)).toThrow('Bid 0.6 cannot be greater than ask 0.5');
    });

    it('should have BID_GREATER_THAN_ASK reason when bid > ask', () => {
      const bid = OutcomePrice.of(new Decimal(0.60));
      const ask = OutcomePrice.of(new Decimal(0.50));

      try {
        Spread.of(bid, ask);
        throw new Error('Expected SpreadInvariantViolation');
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
      const price = OutcomePrice.of(new Decimal(0.50));

      const spread = Spread.zero(price);

      expect(spread.bid()).toBe(price);
      expect(spread.ask()).toBe(price);
      expect(spread.width().toNumber()).toBe(0);
      expect(spread.isZeroWidth()).toBe(true);
    });
  });

  describe('width()', () => {
    it('should calculate spread width correctly', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const width = spread.width();

      expect(width.toNumber()).toBe(0.04);
    });
  });

  describe('mid()', () => {
    it('should calculate mid correctly', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const mid = spread.mid();

      expect(mid.toNumber()).toBe(0.50);
    });
  });

  describe('widthRatio()', () => {
    it('should calculate width ratio correctly', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const widthRatio = spread.widthRatio();

      // 0.04 / 0.50 = 0.08 (8%)
      expect(widthRatio.toNumber()).toBe(0.08);
    });

    it('should return Ratio.ZERO when spread width is zero', () => {
      // Edge case: нулевой спред (bid === ask) даёт ширину 0, поэтому widthRatio = 0
      const bid = OutcomePrice.of(new Decimal(0.0001));
      const ask = OutcomePrice.of(new Decimal(0.0001));
      const spread = Spread.of(bid, ask);

      const widthRatio = spread.widthRatio();

      expect(widthRatio.toNumber()).toBe(0);
    });
  });

  describe('equals()', () => {
    it('should return true for equal spreads', () => {
      const bid1 = OutcomePrice.of(new Decimal(0.48));
      const ask1 = OutcomePrice.of(new Decimal(0.52));
      const spread1 = Spread.of(bid1, ask1);

      const bid2 = OutcomePrice.of(new Decimal(0.48));
      const ask2 = OutcomePrice.of(new Decimal(0.52));
      const spread2 = Spread.of(bid2, ask2);

      expect(spread1.equals(spread2)).toBe(true);
    });

    it('should return false for different spreads', () => {
      const bid1 = OutcomePrice.of(new Decimal(0.48));
      const ask1 = OutcomePrice.of(new Decimal(0.52));
      const spread1 = Spread.of(bid1, ask1);

      const bid2 = OutcomePrice.of(new Decimal(0.45));
      const ask2 = OutcomePrice.of(new Decimal(0.55));
      const spread2 = Spread.of(bid2, ask2);

      expect(spread1.equals(spread2)).toBe(false);
    });
  });

  describe('isZeroWidth()', () => {
    it('should return true for zero width spread', () => {
      const price = OutcomePrice.of(new Decimal(0.50));
      const spread = Spread.zero(price);

      expect(spread.isZeroWidth()).toBe(true);
    });

    it('should return false for non-zero width spread', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      expect(spread.isZeroWidth()).toBe(false);
    });
  });

  describe('contains()', () => {
    it('should return true when price is within spread', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const priceInside = OutcomePrice.of(new Decimal(0.50));

      expect(spread.contains(priceInside)).toBe(true);
    });

    it('should return true when price equals bid', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      expect(spread.contains(bid)).toBe(true);
    });

    it('should return true when price equals ask', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      expect(spread.contains(ask)).toBe(true);
    });

    it('should return false when price is below bid', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const priceBelow = OutcomePrice.of(new Decimal(0.40));

      expect(spread.contains(priceBelow)).toBe(false);
    });

    it('should return false when price is above ask', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      const priceAbove = OutcomePrice.of(new Decimal(0.60));

      expect(spread.contains(priceAbove)).toBe(false);
    });
  });

  describe('widthInBasisPoints()', () => {
    it('should return width in basis points', () => {
      const bid = OutcomePrice.of(new Decimal(0.48));
      const ask = OutcomePrice.of(new Decimal(0.52));
      const spread = Spread.of(bid, ask);

      // 0.04 * 10000 = 400 bp
      expect(spread.widthInBasisPoints()).toEqual(new Decimal(400));
    });

    it('should return 0 for zero-width spread', () => {
      const price = OutcomePrice.of(new Decimal(0.50));
      const spread = Spread.zero(price);

      expect(spread.widthInBasisPoints()).toEqual(new Decimal(0));
    });

    it('should return correct bp for narrow spread', () => {
      const bid = OutcomePrice.of(new Decimal(0.4995));
      const ask = OutcomePrice.of(new Decimal(0.5005));
      const spread = Spread.of(bid, ask);

      // 0.001 * 10000 = 10 bp
      expect(spread.widthInBasisPoints()).toEqual(new Decimal(10));
    });
  });

  describe('overlaps()', () => {
    it('should return true when spreads overlap', () => {
      const s1 = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.60)));
      const s2 = Spread.of(OutcomePrice.of(new Decimal(0.50)), OutcomePrice.of(new Decimal(0.70)));

      expect(s1.overlaps(s2)).toBe(true);
      expect(s2.overlaps(s1)).toBe(true); // симметрично
    });

    it('should return false when spreads do not overlap', () => {
      const s1 = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.50)));
      const s2 = Spread.of(OutcomePrice.of(new Decimal(0.60)), OutcomePrice.of(new Decimal(0.70)));

      expect(s1.overlaps(s2)).toBe(false);
      expect(s2.overlaps(s1)).toBe(false); // симметрично
    });

    it('should return true when spreads touch at boundary', () => {
      const s1 = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.50)));
      const s2 = Spread.of(OutcomePrice.of(new Decimal(0.50)), OutcomePrice.of(new Decimal(0.60)));

      // Граничный случай: ask1 == bid2
      expect(s1.overlaps(s2)).toBe(true);
      expect(s2.overlaps(s1)).toBe(true);
    });

    it('should return true when one spread contains another', () => {
      const outer = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.60)));
      const inner = Spread.of(OutcomePrice.of(new Decimal(0.45)), OutcomePrice.of(new Decimal(0.55)));

      expect(outer.overlaps(inner)).toBe(true);
      expect(inner.overlaps(outer)).toBe(true);
    });

    it('should return true for identical spreads', () => {
      const s1 = Spread.of(OutcomePrice.of(new Decimal(0.48)), OutcomePrice.of(new Decimal(0.52)));
      const s2 = Spread.of(OutcomePrice.of(new Decimal(0.48)), OutcomePrice.of(new Decimal(0.52)));

      expect(s1.overlaps(s2)).toBe(true);
    });
  });

  describe('containsSpread()', () => {
    it('should return true when spread fully contains another', () => {
      const outer = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.60)));
      const inner = Spread.of(OutcomePrice.of(new Decimal(0.45)), OutcomePrice.of(new Decimal(0.55)));

      expect(outer.containsSpread(inner)).toBe(true);
    });

    it('should return false when spread does not contain another', () => {
      const s1 = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.60)));
      const s2 = Spread.of(OutcomePrice.of(new Decimal(0.50)), OutcomePrice.of(new Decimal(0.70)));

      // s2 выходит за границы s1
      expect(s1.containsSpread(s2)).toBe(false);
    });

    it('should return true for identical spreads', () => {
      const s1 = Spread.of(OutcomePrice.of(new Decimal(0.48)), OutcomePrice.of(new Decimal(0.52)));
      const s2 = Spread.of(OutcomePrice.of(new Decimal(0.48)), OutcomePrice.of(new Decimal(0.52)));

      expect(s1.containsSpread(s2)).toBe(true);
    });

    it('should return true when inner spread touches boundaries', () => {
      const outer = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.60)));
      const inner = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.60)));

      // Точное совпадение границ - содержится
      expect(outer.containsSpread(inner)).toBe(true);
    });

    it('should return false when inner spread exceeds lower bound', () => {
      const outer = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.60)));
      const inner = Spread.of(OutcomePrice.of(new Decimal(0.35)), OutcomePrice.of(new Decimal(0.55)));

      expect(outer.containsSpread(inner)).toBe(false);
    });

    it('should return false when inner spread exceeds upper bound', () => {
      const outer = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.60)));
      const inner = Spread.of(OutcomePrice.of(new Decimal(0.45)), OutcomePrice.of(new Decimal(0.65)));

      expect(outer.containsSpread(inner)).toBe(false);
    });

    it('should not be symmetric', () => {
      const outer = Spread.of(OutcomePrice.of(new Decimal(0.40)), OutcomePrice.of(new Decimal(0.60)));
      const inner = Spread.of(OutcomePrice.of(new Decimal(0.45)), OutcomePrice.of(new Decimal(0.55)));

      expect(outer.containsSpread(inner)).toBe(true);
      expect(inner.containsSpread(outer)).toBe(false); // НЕ симметрично
    });
  });
});
