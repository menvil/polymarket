/**
 * Тесты для Quantity value object
 */

import { describe, it, expect } from '@jest/globals';
import { unwrap } from '@polymarket/result';
import {
  InvalidQuantityError,
  ArithmeticOverflowError,
  DivisionByZeroError
} from '@polymarket/errors';
import { Quantity } from '../../src/Quantity';

describe('Quantity', () => {
  describe('Factory Methods', () => {
    describe('fromNumber', () => {
      it('should create Quantity from valid number', () => {
        const result = Quantity.fromValue(10);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(10);
        }
      });

      it('should create Quantity with custom minSize', () => {
        const result = Quantity.fromValue(5, 5);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(5);
        }
      });

      it('should allow zero quantity', () => {
        const result = Quantity.fromValue(0);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(0);
        }
      });

      it('should reject negative quantity', () => {
        const result = Quantity.fromValue(-10);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
          expect(result.error.message).toContain('Invalid quantity');
        }
      });

      it('should reject quantity below minSize', () => {
        const result = Quantity.fromValue(5, 10);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
        }
      });

      it('should reject NaN', () => {
        const result = Quantity.fromValue(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
        }
      });

      it('should reject Infinity', () => {
        const result = Quantity.fromValue(Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
        }
      });
    });

    describe('fromMarketData', () => {
      it('should create Quantity from market data', () => {
        const result = Quantity.fromMarketData(0.07);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(0.07);
        }
      });

      it('should allow values below MIN_SIZE', () => {
        const result = Quantity.fromMarketData(0.5);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(0.5);
        }
      });

      it('should allow zero', () => {
        const result = Quantity.fromMarketData(0);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(0);
        }
      });

      it('should reject negative values', () => {
        const result = Quantity.fromMarketData(-1);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
        }
      });

      it('should reject NaN', () => {
        const result = Quantity.fromMarketData(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
        }
      });
    });

    describe('zero', () => {
      it('should create zero quantity', () => {
        const qty = Quantity.zero();

        expect(qty.value).toBe(0);
      });
    });

    describe('isValid', () => {
      it('should validate correct quantities', () => {
        expect(Quantity.isValid(10)).toBe(true);
        expect(Quantity.isValid(0)).toBe(true);
        expect(Quantity.isValid(1000)).toBe(true);
      });

      it('should reject invalid quantities', () => {
        expect(Quantity.isValid(-10)).toBe(false);
        expect(Quantity.isValid(NaN)).toBe(false);
        expect(Quantity.isValid(Infinity)).toBe(false);
      });

      it('should respect minSize', () => {
        expect(Quantity.isValid(5, 10)).toBe(false);
        expect(Quantity.isValid(10, 10)).toBe(true);
        expect(Quantity.isValid(15, 10)).toBe(true);
      });

      it('should allow zero regardless of minSize', () => {
        expect(Quantity.isValid(0, 10)).toBe(true);
      });
    });
  });

  describe('Operations', () => {
    describe('toTick', () => {
      it('should round to tick size', () => {
        const qty = unwrap(Quantity.fromValue(10.567));
        const rounded = unwrap(qty.toTick(0.01));

        expect(rounded.value).toBe(10.57);
      });

      it('should round to default tick size', () => {
        const qty = unwrap(Quantity.fromValue(10.567));
        const rounded = unwrap(qty.toTick());

        expect(rounded.value).toBe(10.57);
      });
    });

    describe('floorToTick', () => {
      it('should floor to tick size', () => {
        const qty = unwrap(Quantity.fromValue(10.569));
        const floored = unwrap(qty.floorToTick(0.01));

        expect(floored.value).toBe(10.56);
      });
    });

    describe('ceilToTick', () => {
      it('should ceil to tick size', () => {
        const qty = unwrap(Quantity.fromValue(10.561));
        const ceiled = unwrap(qty.ceilToTick(0.01));

        expect(ceiled.value).toBe(10.57);
      });
    });

    describe('add', () => {
      it('should add quantities', () => {
        const q1 = unwrap(Quantity.fromValue(10));
        const q2 = unwrap(Quantity.fromValue(5));

        const result = unwrap(q1.add(q2));

        expect(result.value).toBe(15);
      });

      it('should return error on overflow', () => {
        const q1 = unwrap(Quantity.fromValue(Number.MAX_VALUE));
        const q2 = unwrap(Quantity.fromValue(Number.MAX_VALUE));

        const result = q1.add(q2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
        }
      });
    });

    describe('subtract', () => {
      it('should subtract quantities', () => {
        const q1 = unwrap(Quantity.fromValue(10));
        const q2 = unwrap(Quantity.fromValue(3));

        const result = unwrap(q1.subtract(q2));

        expect(result.value).toBe(7);
      });

      it('should return error on negative result', () => {
        const q1 = unwrap(Quantity.fromValue(5));
        const q2 = unwrap(Quantity.fromValue(10));

        const result = q1.subtract(q2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
        }
      });

      it('should allow zero result', () => {
        const q1 = unwrap(Quantity.fromValue(10));
        const q2 = unwrap(Quantity.fromValue(10));

        const result = unwrap(q1.subtract(q2));

        expect(result.value).toBe(0);
      });
    });

    describe('multiply', () => {
      it('should multiply by factor', () => {
        const qty = unwrap(Quantity.fromValue(10));

        const result = unwrap(qty.multiply(2.5));

        expect(result.value).toBe(25);
      });

      it('should allow multiplication by zero', () => {
        const qty = unwrap(Quantity.fromValue(10));

        const result = unwrap(qty.multiply(0));

        expect(result.value).toBe(0);
      });

      it('should return error on negative factor', () => {
        const qty = unwrap(Quantity.fromValue(10));

        const result = qty.multiply(-2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
        }
      });

      it('should return error on NaN factor', () => {
        const qty = unwrap(Quantity.fromValue(10));

        const result = qty.multiply(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
        }
      });
    });

    describe('divide', () => {
      it('should divide by divisor', () => {
        const qty = unwrap(Quantity.fromValue(10));

        const result = unwrap(qty.divide(2));

        expect(result.value).toBe(5);
      });

      it('should return error on zero divisor', () => {
        const qty = unwrap(Quantity.fromValue(10));

        const result = qty.divide(0);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(DivisionByZeroError);
        }
      });

      it('should return error on negative divisor', () => {
        const qty = unwrap(Quantity.fromValue(10));

        const result = qty.divide(-2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
        }
      });

      it('should return error on NaN divisor', () => {
        const qty = unwrap(Quantity.fromValue(10));

        const result = qty.divide(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuantityError);
        }
      });
    });
  });

  describe('Comparison', () => {
    describe('isGreaterThan', () => {
      it('should return true when quantity is greater', () => {
        const q1 = unwrap(Quantity.fromValue(15));
        const q2 = unwrap(Quantity.fromValue(10));

        expect(q1.isGreaterThan(q2)).toBe(true);
      });

      it('should return false when quantity is less', () => {
        const q1 = unwrap(Quantity.fromValue(10));
        const q2 = unwrap(Quantity.fromValue(15));

        expect(q1.isGreaterThan(q2)).toBe(false);
      });

      it('should return false when quantities are equal', () => {
        const q1 = unwrap(Quantity.fromValue(10));
        const q2 = unwrap(Quantity.fromValue(10));

        expect(q1.isGreaterThan(q2)).toBe(false);
      });
    });

    describe('isLessThan', () => {
      it('should return true when quantity is less', () => {
        const q1 = unwrap(Quantity.fromValue(10));
        const q2 = unwrap(Quantity.fromValue(15));

        expect(q1.isLessThan(q2)).toBe(true);
      });

      it('should return false when quantity is greater', () => {
        const q1 = unwrap(Quantity.fromValue(15));
        const q2 = unwrap(Quantity.fromValue(10));

        expect(q1.isLessThan(q2)).toBe(false);
      });
    });

    describe('equals', () => {
      it('should return true for equal quantities', () => {
        const q1 = unwrap(Quantity.fromValue(10));
        const q2 = unwrap(Quantity.fromValue(10));

        expect(q1.equals(q2)).toBe(true);
      });

      it('should return false for different quantities', () => {
        const q1 = unwrap(Quantity.fromValue(10));
        const q2 = unwrap(Quantity.fromValue(15));

        expect(q1.equals(q2)).toBe(false);
      });

      it('should handle epsilon for floating point comparison', () => {
        const q1 = unwrap(Quantity.fromValue(10));
        const q2 = unwrap(Quantity.fromValue(10 + 1e-5));

        expect(q1.equals(q2)).toBe(true);
      });
    });

    describe('isZero', () => {
      it('should return true for zero quantity', () => {
        const qty = Quantity.zero();

        expect(qty.isZero()).toBe(true);
      });

      it('should return false for non-zero quantity', () => {
        const qty = unwrap(Quantity.fromValue(10));

        expect(qty.isZero()).toBe(false);
      });

      it('should handle epsilon', () => {
        const qty = unwrap(Quantity.fromMarketData(1e-5));

        expect(qty.isZero()).toBe(true);
      });
    });

    describe('isPositive', () => {
      it('should return true for positive quantity', () => {
        const qty = unwrap(Quantity.fromValue(10));

        expect(qty.isPositive()).toBe(true);
      });

      it('should return false for zero quantity', () => {
        const qty = Quantity.zero();

        expect(qty.isPositive()).toBe(false);
      });
    });
  });

  describe('Utilities', () => {
    describe('toString', () => {
      it('should format with default decimals', () => {
        const qty = unwrap(Quantity.fromValue(10.567));

        expect(qty.toString()).toBe('10.57');
      });

      it('should format with specified decimals', () => {
        const qty = unwrap(Quantity.fromValue(10.567));

        expect(qty.toString(0)).toBe('11');
        expect(qty.toString(1)).toBe('10.6');
        expect(qty.toString(3)).toBe('10.567');
      });
    });

    describe('static getter', () => {
      it('should return minSize', () => {
        expect(Quantity.minSize).toBe(1);
      });
    });
  });

  describe('Integration', () => {
    it('should handle order size calculation', () => {
      // Available balance: 100 units
      const balance = unwrap(Quantity.fromValue(100));

      // Order 30 units
      const orderSize = unwrap(Quantity.fromValue(30));

      // Calculate remaining
      const remaining = unwrap(balance.subtract(orderSize));

      expect(remaining.value).toBe(70);
    });

    it('should handle partial fills from market', () => {
      // Original order: 100 units
      const originalOrder = unwrap(Quantity.fromValue(100));

      // Filled 37.5 units (from market data)
      const filled = unwrap(Quantity.fromMarketData(37.5));

      // Calculate remaining to fill
      const remaining = unwrap(originalOrder.subtract(filled));

      expect(remaining.value).toBe(62.5);
    });

    it('should handle quantity rounding for orders', () => {
      // Calculate desired quantity: 10.567 units
      const desired = unwrap(Quantity.fromValue(10.567));

      // Round to market tick size (0.1)
      const rounded = unwrap(desired.floorToTick(0.1));

      expect(rounded.value).toBe(10.5);
    });

    it('should handle position sizing', () => {
      // Portfolio: 1000 units
      const portfolio = unwrap(Quantity.fromValue(1000));

      // Risk 2% per trade
      const riskPercent = 0.02;

      // Calculate position size
      const positionSize = unwrap(portfolio.multiply(riskPercent));

      expect(positionSize.value).toBe(20);
    });
  });

  describe('Serialization', () => {
    describe('toJSON', () => {
      it('should serialize quantity to JSON', () => {
        const qty = unwrap(Quantity.fromValue(100));
        const json = qty.toJSON();

        expect(json).toEqual({ value: 100 });
      });

      it('should serialize ZERO', () => {
        const json = Quantity.ZERO.toJSON();

        expect(json).toEqual({ value: 0 });
      });

      it('should serialize ONE', () => {
        const json = Quantity.ONE.toJSON();

        expect(json).toEqual({ value: 1 });
      });
    });

    describe('fromJSON', () => {
      it('should deserialize valid quantity from JSON', () => {
        const json = { value: 50 };
        const result = Quantity.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(50);
        }
      });

      it('should reject negative quantity from JSON', () => {
        const json = { value: -10 };
        const result = Quantity.fromJSON(json);

        expect(result.ok).toBe(false);
      });

      it('should round-trip correctly', () => {
        const original = unwrap(Quantity.fromValue(123.456));
        const json = original.toJSON();
        const deserialized = unwrap(Quantity.fromJSON(json));

        expect(deserialized.equals(original)).toBe(true);
      });
    });
  });
});
