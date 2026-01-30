/**
 * Тесты для Price value object
 */

import { describe, it, expect } from '@jest/globals';
import { unwrap } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';
import { Price } from '../../src/Price';

describe('Price', () => {
  describe('Factory Methods', () => {
    describe('fromValue', () => {
      it('should create Price from valid number', () => {
        const result = Price.fromValue(0.5);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(0.5);
        }
      });

      it('should create Price from minimum valid value', () => {
        const result = Price.fromValue(0.0001);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(0.0001);
        }
      });

      it('should create Price from maximum valid value', () => {
        const result = Price.fromValue(0.9999);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(0.9999);
        }
      });

      it('should reject negative price', () => {
        const result = Price.fromValue(-0.5);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
          expect(result.error.message).toContain('Invalid price');
        }
      });

      it('should reject price below minimum', () => {
        const result = Price.fromValue(0.00001);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });

      it('should reject price above maximum', () => {
        const result = Price.fromValue(1.0);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });

      it('should reject NaN', () => {
        const result = Price.fromValue(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });

      it('should reject Infinity', () => {
        const result = Price.fromValue(Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });

      it('should create Price from valid string', () => {
        const result = Price.fromValue('0.5234');

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(0.5234);
        }
      });

      it('should reject invalid string', () => {
        const result = Price.fromValue('not a number');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
          expect(result.error.message).toContain('not a number');
        }
      });

      it('should reject empty string', () => {
        const result = Price.fromValue('');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });
    });

    describe('isValid', () => {
      it('should validate correct prices', () => {
        expect(Price.isValid(0.5)).toBe(true);
        expect(Price.isValid(0.0001)).toBe(true);
        expect(Price.isValid(0.9999)).toBe(true);
      });

      it('should reject invalid prices', () => {
        expect(Price.isValid(-0.5)).toBe(false);
        expect(Price.isValid(0)).toBe(false);
        expect(Price.isValid(1.0)).toBe(false);
        expect(Price.isValid(NaN)).toBe(false);
        expect(Price.isValid(Infinity)).toBe(false);
      });
    });
  });

  describe('Operations', () => {
    describe('toTick', () => {
      it('should round to tick size', () => {
        const price = unwrap(Price.fromValue(0.5234));
        const rounded = unwrap(price.toTick(0.01));

        expect(rounded.value).toBe(0.52);
      });

      it('should round to default tick size', () => {
        const price = unwrap(Price.fromValue(0.52345));
        const rounded = unwrap(price.toTick());

        // 0.52345 округляется до 0.5235 (round-half-up)
        // так как 0.52345 ровно посередине между 0.5234 и 0.5235
        expect(rounded.value).toBe(0.5235);
      });

      it('should handle very small tick sizes with exponential notation', () => {
        const price = unwrap(Price.fromValue(0.12345678));
        const rounded = unwrap(price.toTick(1e-7));

        // Should round to 7 decimal places (1e-7 = 0.0000001)
        expect(rounded.value).toBeCloseTo(0.1234568, 7);
      });

      it('should handle tick size 1e-6', () => {
        const price = unwrap(Price.fromValue(0.123456789));
        const rounded = unwrap(price.toTick(1e-6));

        // Should round to 6 decimal places
        expect(rounded.value).toBeCloseTo(0.123457, 6);
      });

      it('should handle tick size 1e-10', () => {
        const price = unwrap(Price.fromValue(0.123456789012));
        const rounded = unwrap(price.toTick(1e-10));

        // Should round to 10 decimal places
        expect(rounded.value).toBeCloseTo(0.123456789, 10);
      });
    });

    describe('floorToTick', () => {
      it('should floor to tick size', () => {
        const price = unwrap(Price.fromValue(0.5239));
        const floored = unwrap(price.floorToTick(0.01));

        expect(floored.value).toBe(0.52);
      });
    });

    describe('ceilToTick', () => {
      it('should ceil to tick size', () => {
        const price = unwrap(Price.fromValue(0.5231));
        const ceiled = unwrap(price.ceilToTick(0.01));

        expect(ceiled.value).toBe(0.53);
      });
    });

    describe('add', () => {
      it('should add amount to price', () => {
        const price = unwrap(Price.fromValue(0.5));
        const result = unwrap(price.add(0.05));

        expect(result.value).toBe(0.55);
      });

      it('should return error when exceeding maximum', () => {
        const price = unwrap(Price.fromValue(0.98));
        const result = price.add(0.05);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
          expect(result.error.message).toContain('must be in range');
        }
      });

      it('should return error on negative amount', () => {
        const price = unwrap(Price.fromValue(0.5));

        const result = price.add(-0.1);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });

      it('should return error on NaN amount', () => {
        const price = unwrap(Price.fromValue(0.5));

        const result = price.add(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });
    });

    describe('subtract', () => {
      it('should subtract amount from price', () => {
        const price = unwrap(Price.fromValue(0.5));
        const result = unwrap(price.subtract(0.05));

        expect(result.value).toBe(0.45);
      });

      it('should return error when going below minimum', () => {
        const price = unwrap(Price.fromValue(0.002));
        const result = price.subtract(0.002);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
          expect(result.error.message).toContain('must be in range');
        }
      });

      it('should return error on negative amount', () => {
        const price = unwrap(Price.fromValue(0.5));

        const result = price.subtract(-0.1);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });
    });

    describe('multiply', () => {
      it('should multiply price by factor', () => {
        const price = unwrap(Price.fromValue(0.4));
        const result = unwrap(price.multiply(2));

        expect(result.value).toBe(0.8);
      });

      it('should return error when result exceeds bounds', () => {
        const price = unwrap(Price.fromValue(0.99));
        const result = price.multiply(2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
          expect(result.error.message).toContain('must be in range');
        }
      });

      it('should return error on negative factor', () => {
        const price = unwrap(Price.fromValue(0.5));

        const result = price.multiply(-1);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });
    });
  });

  describe('Comparison', () => {
    describe('isGreaterThan', () => {
      it('should return true when price is greater', () => {
        const p1 = unwrap(Price.fromValue(0.6));
        const p2 = unwrap(Price.fromValue(0.5));

        expect(p1.isGreaterThan(p2)).toBe(true);
      });

      it('should return false when price is less', () => {
        const p1 = unwrap(Price.fromValue(0.5));
        const p2 = unwrap(Price.fromValue(0.6));

        expect(p1.isGreaterThan(p2)).toBe(false);
      });

      it('should return false when prices are equal', () => {
        const p1 = unwrap(Price.fromValue(0.5));
        const p2 = unwrap(Price.fromValue(0.5));

        expect(p1.isGreaterThan(p2)).toBe(false);
      });
    });

    describe('isLessThan', () => {
      it('should return true when price is less', () => {
        const p1 = unwrap(Price.fromValue(0.5));
        const p2 = unwrap(Price.fromValue(0.6));

        expect(p1.isLessThan(p2)).toBe(true);
      });

      it('should return false when price is greater', () => {
        const p1 = unwrap(Price.fromValue(0.6));
        const p2 = unwrap(Price.fromValue(0.5));

        expect(p1.isLessThan(p2)).toBe(false);
      });
    });

    describe('equals', () => {
      it('should return true for equal prices', () => {
        const p1 = unwrap(Price.fromValue(0.5));
        const p2 = unwrap(Price.fromValue(0.5));

        expect(p1.equals(p2)).toBe(true);
      });

      it('should return false for different prices', () => {
        const p1 = unwrap(Price.fromValue(0.5));
        const p2 = unwrap(Price.fromValue(0.6));

        expect(p1.equals(p2)).toBe(false);
      });

      it('should handle epsilon for floating point comparison', () => {
        const p1 = unwrap(Price.fromValue(0.5));
        const p2 = unwrap(Price.fromValue(0.5 + 1e-8));

        expect(p1.equals(p2)).toBe(true);
      });
    });
  });

  describe('Utilities', () => {
    describe('toString', () => {
      it('should format with default decimals', () => {
        const price = unwrap(Price.fromValue(0.5234));

        expect(price.toString()).toBe('0.5234');
      });

      it('should format with specified decimals', () => {
        const price = unwrap(Price.fromValue(0.5234));

        expect(price.toString(2)).toBe('0.52');
      });
    });

    describe('toPercentage', () => {
      it('should convert to percentage string', () => {
        const price = unwrap(Price.fromValue(0.5234));

        expect(price.toPercentage()).toBe('52.34%');
      });

      it('should handle edge cases', () => {
        const low = unwrap(Price.fromValue(0.0001));
        const high = unwrap(Price.fromValue(0.9999));

        expect(low.toPercentage()).toBe('0.01%');
        expect(high.toPercentage()).toBe('99.99%');
      });
    });

    describe('static getters', () => {
      it('should return min price', () => {
        expect(Price.minPrice).toBe(0.0001);
      });

      it('should return max price', () => {
        expect(Price.maxPrice).toBe(0.9999);
      });
    });
  });

  describe('Integration', () => {
    it('should handle real-world trading scenario', () => {
      // Create a market price
      const marketPrice = unwrap(Price.fromValue('0.6547'));

      // Adjust for spread
      const bidPrice = unwrap(marketPrice.subtract(0.005));
      const askPrice = unwrap(marketPrice.add(0.005));

      expect(bidPrice.value).toBeCloseTo(0.6497, 4);
      expect(askPrice.value).toBeCloseTo(0.6597, 4);

      // Round to tick
      const roundedBid = unwrap(bidPrice.floorToTick(0.01));
      const roundedAsk = unwrap(askPrice.ceilToTick(0.01));

      expect(roundedBid.value).toBe(0.64);
      expect(roundedAsk.value).toBe(0.66);
    });

    it('should handle price updates', () => {
      const initialPrice = unwrap(Price.fromValue(0.5));

      // Price moved up 10%
      const newPrice = unwrap(initialPrice.multiply(1.1));

      expect(newPrice.value).toBe(0.55);

      // Convert to percentage
      expect(newPrice.toPercentage()).toBe('55.00%');
    });
  });

  describe('Serialization', () => {
    describe('toJSON', () => {
      it('should serialize price to JSON', () => {
        const price = unwrap(Price.fromValue(0.5));
        const json = price.toJSON();

        expect(json).toEqual({ value: 0.5 });
      });

      it('should serialize MIN price', () => {
        const json = Price.MIN.toJSON();

        expect(json).toEqual({ value: 0.0001 });
      });

      it('should serialize MAX price', () => {
        const json = Price.MAX.toJSON();

        expect(json).toEqual({ value: 0.9999 });
      });
    });

    describe('fromJSON', () => {
      it('should deserialize valid price from JSON', () => {
        const json = { value: 0.5 };
        const result = Price.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(0.5);
        }
      });

      it('should reject invalid price from JSON', () => {
        const json = { value: 1.5 };
        const result = Price.fromJSON(json);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPriceError);
        }
      });

      it('should round-trip correctly', () => {
        const original = unwrap(Price.fromValue(0.6789));
        const json = original.toJSON();
        const deserialized = unwrap(Price.fromJSON(json));

        expect(deserialized.equals(original)).toBe(true);
      });
    });
  });
});
