/**
 * Тесты для Spread value object
 */

import { describe, it, expect } from '@jest/globals';
import { unwrap } from '@polymarket/result';
import { InvalidSpreadError, InvalidPriceError } from '@polymarket/errors';
import { Price } from '../../src/Price';
import { Spread } from '../../src/Spread';

describe('Spread', () => {
  const createValidBid = () => unwrap(Price.fromValue(0.48));
  const createValidAsk = () => unwrap(Price.fromValue(0.52));

  describe('Factory Methods', () => {
    describe('create', () => {
      it('should create Spread from valid prices', () => {
        const bid = createValidBid();
        const ask = createValidAsk();

        const result = Spread.create(bid, ask);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid.value).toBe(0.48);
          expect(result.value.ask.value).toBe(0.52);
        }
      });

      it('should create Spread with equal bid and ask', () => {
        const price = unwrap(Price.fromValue(0.5));

        const result = Spread.create(price, price);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZeroWidth()).toBe(true);
        }
      });

      it('should reject bid > ask', () => {
        const bid = unwrap(Price.fromValue(0.6));
        const ask = unwrap(Price.fromValue(0.5));

        const result = Spread.create(bid, ask);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidSpreadError);
          expect(result.error.message).toContain('Invalid spread');
        }
      });
    });

    describe('fromNumbers', () => {
      it('should create Spread from valid numbers', () => {
        const result = Spread.fromNumbers(0.48, 0.52);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.width()).toBeCloseTo(0.04, 2);
        }
      });

      it('should reject invalid price numbers', () => {
        const result = Spread.fromNumbers(1.5, 2.0);

        expect(result.ok).toBe(false);
      });

      it('should reject invalid bid price', () => {
        const result = Spread.fromNumbers(1.5, 0.5);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });

      it('should reject invalid ask price', () => {
        const result = Spread.fromNumbers(0.5, 1.5);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });

      it('should reject bid > ask', () => {
        const result = Spread.fromNumbers(0.6, 0.5);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidSpreadError);
        }
      });
    });

    describe('zero', () => {
      it('should create zero-width spread', () => {
        const price = unwrap(Price.fromValue(0.5));
        const spread = Spread.zero(price);

        expect(spread.width()).toBe(0);
        expect(spread.isZeroWidth()).toBe(true);
      });
    });

    describe('isValid', () => {
      it('should validate valid spreads', () => {
        const bid = unwrap(Price.fromValue(0.48));
        const ask = unwrap(Price.fromValue(0.52));

        expect(Spread.isValid(bid, ask)).toBe(true);
      });

      it('should reject invalid spreads', () => {
        const bid = unwrap(Price.fromValue(0.6));
        const ask = unwrap(Price.fromValue(0.5));

        expect(Spread.isValid(bid, ask)).toBe(false);
      });

      it('should allow equal prices', () => {
        const price = unwrap(Price.fromValue(0.5));

        expect(Spread.isValid(price, price)).toBe(true);
      });
    });
  });

  describe('Metrics', () => {
    describe('width', () => {
      it('should calculate spread width', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        expect(spread.width()).toBeCloseTo(0.04, 2);
      });

      it('should return zero for zero-width spread', () => {
        const price = unwrap(Price.fromValue(0.5));
        const spread = Spread.zero(price);

        expect(spread.width()).toBe(0);
      });
    });

    describe('widthPercentage', () => {
      it('should calculate spread width percentage', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const percentage = spread.widthPercentage();

        expect(percentage).toBeCloseTo(8, 1); // (0.04 / 0.5) * 100 = 8%
      });

      it('should handle wide spreads', () => {
        const spread = unwrap(Spread.fromNumbers(0.01, 0.99));

        const percentage = spread.widthPercentage();

        expect(percentage).toBeGreaterThan(100);
      });

      it('should handle extreme boundary spreads', () => {
        const spread = unwrap(Spread.fromNumbers(0.0001, 0.9999));

        const percentage = spread.widthPercentage();

        expect(percentage).toBeGreaterThan(100);
      });
    });

    describe('midpoint', () => {
      it('should calculate midpoint', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const mid = spread.midpoint();

        expect(mid.value).toBe(0.5);
      });
    });

    describe('isZeroWidth', () => {
      it('should return true for zero-width spread', () => {
        const price = unwrap(Price.fromValue(0.5));
        const spread = Spread.zero(price);

        expect(spread.isZeroWidth()).toBe(true);
      });

      it('should return false for non-zero spread', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        expect(spread.isZeroWidth()).toBe(false);
      });
    });

    describe('isWide', () => {
      it('should detect wide spread with default threshold', () => {
        const spread = unwrap(Spread.fromNumbers(0.45, 0.55));

        expect(spread.isWide()).toBe(true);
      });

      it('should detect narrow spread', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        expect(spread.isWide()).toBe(false);
      });

      it('should use custom threshold', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        expect(spread.isWide(0.02)).toBe(true);
        expect(spread.isWide(0.1)).toBe(false);
      });
    });
  });

  describe('Operations', () => {
    describe('tighten', () => {
      it('should tighten spread', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const tightened = unwrap(spread.tighten(0.01));

        expect(tightened.bid.value).toBeCloseTo(0.49, 2);
        expect(tightened.ask.value).toBeCloseTo(0.51, 2);
        expect(tightened.width()).toBeCloseTo(0.02, 2);
      });

      it('should cap tighten amount at half width', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const tightened = unwrap(spread.tighten(0.1)); // More than half width

        expect(tightened.isZeroWidth()).toBe(true);
      });

      it('should return error on negative amount', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const result = spread.tighten(-0.01);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('must be >= 0');
        }
      });

      it('should return error on NaN amount', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const result = spread.tighten(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('must be a finite number');
        }
      });
    });

    describe('widen', () => {
      it('should widen spread', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const widened = unwrap(spread.widen(0.02));

        expect(widened.bid.value).toBeCloseTo(0.46, 2);
        expect(widened.ask.value).toBeCloseTo(0.54, 2);
        expect(widened.width()).toBeCloseTo(0.08, 2);
      });

      it('should return error when exceeding price boundaries', () => {
        const spread = unwrap(Spread.fromNumbers(0.001, 0.999));

        const result = spread.widen(0.1);

        // Should return error when bid/ask go out of bounds
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('must be in range');
        }
      });

      it('should return error on negative amount', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const result = spread.widen(-0.01);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('must be >= 0');
        }
      });

      it('should return error on NaN amount', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const result = spread.widen(Number.NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toMatch(/NaN|finite|invalid/i);
        }
      });

      it('should return error on Infinity amount', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const result = spread.widen(Number.POSITIVE_INFINITY);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toMatch(/Infinity|finite|invalid/i);
        }
      });
    });

    describe('shift', () => {
      it('should shift spread up', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const result = spread.shift(0.05);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const shifted = result.value;
          expect(shifted.bid.value).toBeCloseTo(0.53, 2);
          expect(shifted.ask.value).toBeCloseTo(0.57, 2);
          expect(shifted.width()).toBeCloseTo(0.04, 2); // Width preserved
        }
      });

      it('should shift spread down', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const result = spread.shift(-0.05);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const shifted = result.value;
          expect(shifted.bid.value).toBeCloseTo(0.43, 2);
          expect(shifted.ask.value).toBeCloseTo(0.47, 2);
          expect(shifted.width()).toBeCloseTo(0.04, 2);
        }
      });

      it('should clamp at price boundaries when shifting down', () => {
        const spread = unwrap(Spread.fromNumbers(0.005, 0.045));

        const result = spread.shift(-0.1);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const shiftedDown = result.value;
          expect(shiftedDown.bid.value).toBe(0.0001);
          expect(shiftedDown.width()).toBeCloseTo(0.04, 2);
        }
      });

      it('should clamp at price boundaries when shifting up', () => {
        const spread = unwrap(Spread.fromNumbers(0.955, 0.995));

        const result = spread.shift(0.1);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const shiftedUp = result.value;
          expect(shiftedUp.ask.value).toBe(0.9999);
          expect(shiftedUp.width()).toBeCloseTo(0.04, 2);
        }
      });

      it('should handle extreme positive shift gracefully', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        // Very large shift that would exceed MAX_PRICE
        const result = spread.shift(1000);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const shifted = result.value;
          // Should clamp to MAX_PRICE
          expect(shifted.ask.value).toBeLessThanOrEqual(0.9999);
        }
      });

      it('should handle extreme negative shift gracefully', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        // Very large negative shift that would go below MIN_PRICE
        const result = spread.shift(-1000);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const shifted = result.value;
          // Should clamp to MIN_PRICE
          expect(shifted.bid.value).toBeGreaterThanOrEqual(0.0001);
        }
      });

      it('should reject NaN shift amount', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const result = spread.shift(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidSpreadError);
          expect(result.error.message).toContain('must be a finite number');
        }
      });

      it('should reject Infinity shift amount', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const result = spread.shift(Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidSpreadError);
          expect(result.error.message).toContain('must be a finite number');
        }
      });

      it('should reject -Infinity shift amount', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const result = spread.shift(-Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidSpreadError);
          expect(result.error.message).toContain('must be a finite number');
        }
      });
    });
  });

  describe('Utilities', () => {
    describe('contains', () => {
      it('should return true for price within spread', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));
        const price = unwrap(Price.fromValue(0.5));

        expect(spread.contains(price)).toBe(true);
      });

      it('should return false for price outside spread', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));
        const price = unwrap(Price.fromValue(0.6));

        expect(spread.contains(price)).toBe(false);
      });

      it('should include boundaries', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));
        const bid = unwrap(Price.fromValue(0.48));
        const ask = unwrap(Price.fromValue(0.52));

        expect(spread.contains(bid)).toBe(true);
        expect(spread.contains(ask)).toBe(true);
      });
    });

    describe('equals', () => {
      it('should return true for equal spreads', () => {
        const s1 = unwrap(Spread.fromNumbers(0.48, 0.52));
        const s2 = unwrap(Spread.fromNumbers(0.48, 0.52));

        expect(s1.equals(s2)).toBe(true);
      });

      it('should return false for different spreads', () => {
        const s1 = unwrap(Spread.fromNumbers(0.48, 0.52));
        const s2 = unwrap(Spread.fromNumbers(0.49, 0.52));

        expect(s1.equals(s2)).toBe(false);
      });
    });

    describe('toString', () => {
      it('should format spread as string', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const str = spread.toString();

        expect(str).toContain('0.4800');
        expect(str).toContain('0.5200');
        expect(str).toContain('0.0400');
      });
    });

    describe('toObject', () => {
      it('should convert to object representation', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));

        const obj = spread.toObject();

        expect(obj.bid).toBe(0.48);
        expect(obj.ask).toBe(0.52);
        expect(obj.width).toBeCloseTo(0.04, 2);
        expect(obj.midpoint).toBe(0.5);
      });
    });
  });

  describe('Integration', () => {
    it('should handle market-making spread adjustment', () => {
      // Start with base spread
      const baseSpread = unwrap(Spread.fromNumbers(0.48, 0.52));

      // Widen to increase profit margin
      const widened = unwrap(baseSpread.widen(0.01));
      expect(widened.width()).toBeCloseTo(0.06, 2);

      // Shift based on inventory
      const shifted = unwrap(widened.shift(-0.02));
      expect(shifted.midpoint().value).toBeCloseTo(0.48, 2);
    });

    it('should handle spread validation for crossing', () => {
      const marketBid = unwrap(Price.fromValue(0.64));
      const marketAsk = unwrap(Price.fromValue(0.66));

      // Our spread crosses market ask
      const crossingSpread = unwrap(Spread.fromNumbers(0.67, 0.69));
      expect(crossingSpread.bid.isGreaterThan(marketAsk)).toBe(true);

      // Our spread is inside market spread
      const insideSpread = unwrap(Spread.fromNumbers(0.645, 0.655));
      expect(insideSpread.bid.isLessThan(marketAsk)).toBe(true);
      expect(insideSpread.ask.isGreaterThan(marketBid)).toBe(true);
    });
  });

  describe('Serialization', () => {
    describe('toJSON', () => {
      it('should serialize spread to JSON', () => {
        const spread = unwrap(Spread.fromNumbers(0.48, 0.52));
        const json = spread.toJSON();

        expect(json).toEqual({ bid: 0.48, ask: 0.52 });
      });

      it('should serialize zero-width spread', () => {
        const price = unwrap(Price.fromValue(0.5));
        const spread = Spread.zero(price);
        const json = spread.toJSON();

        expect(json).toEqual({ bid: 0.5, ask: 0.5 });
      });
    });

    describe('fromJSON', () => {
      it('should deserialize valid spread from JSON', () => {
        const json = { bid: 0.48, ask: 0.52 };
        const result = Spread.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid.value).toBe(0.48);
          expect(result.value.ask.value).toBe(0.52);
        }
      });

      it('should reject invalid spread from JSON (bid > ask)', () => {
        const json = { bid: 0.60, ask: 0.40 };
        const result = Spread.fromJSON(json);

        expect(result.ok).toBe(false);
      });

      it('should reject invalid price values', () => {
        const json = { bid: 1.5, ask: 2.0 };
        const result = Spread.fromJSON(json);

        expect(result.ok).toBe(false);
      });

      it('should round-trip correctly', () => {
        const original = unwrap(Spread.fromNumbers(0.3456, 0.6789));
        const json = original.toJSON();
        const deserialized = unwrap(Spread.fromJSON(json));

        expect(deserialized.equals(original)).toBe(true);
      });
    });
  });
});
