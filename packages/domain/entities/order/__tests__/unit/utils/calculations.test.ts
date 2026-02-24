/**
 * Тесты для calculation utils
 */

import { Quantity, Price } from '@polymarket/value-objects';
import { Decimal } from 'decimal.js';
import { getNotional, getRemainingSize, getFillPercentage } from '../../../src/utils/calculations';

describe('calculations', () => {
  describe('getNotional()', () => {
    it('should calculate notional as price * size', () => {
      const priceResult = Price.fromValue(0.65);
      const sizeResult = Quantity.fromValue(100);

      expect(priceResult.ok).toBe(true);
      expect(sizeResult.ok).toBe(true);

      if (priceResult.ok && sizeResult.ok) {
        const notional = getNotional(priceResult.value, sizeResult.value);
        expect(notional.toNumber()).toBe(65);
      }
    });

    it('should handle decimal precision correctly', () => {
      const priceResult = Price.fromValue(0.333333);
      const sizeResult = Quantity.fromValue(3);

      if (priceResult.ok && sizeResult.ok) {
        const notional = getNotional(priceResult.value, sizeResult.value);
        // 0.333333 * 3 = 0.999999
        expect(notional.toNumber()).toBeCloseTo(0.999999, 6);
      }
    });

    it('should return zero for zero size', () => {
      const priceResult = Price.fromValue(0.65);
      const sizeResult = Quantity.fromValue(0);

      if (priceResult.ok && sizeResult.ok) {
        const notional = getNotional(priceResult.value, sizeResult.value);
        expect(notional.toNumber()).toBe(0);
      }
    });
  });

  describe('getRemainingSize()', () => {
    it('should return full size when no fill', () => {
      const sizeResult = Quantity.fromValue(100);
      const filledSizeResult = Quantity.fromValue(0);

      if (sizeResult.ok && filledSizeResult.ok) {
        const remaining = getRemainingSize(sizeResult.value, filledSizeResult.value);
        expect(remaining.value).toBe(100);
      }
    });

    it('should calculate remaining as size - filledSize', () => {
      const sizeResult = Quantity.fromValue(100);
      const filledSizeResult = Quantity.fromValue(30);

      if (sizeResult.ok && filledSizeResult.ok) {
        const remaining = getRemainingSize(sizeResult.value, filledSizeResult.value);
        expect(remaining.value).toBe(70);
      }
    });

    it('should return zero when fully filled', () => {
      const sizeResult = Quantity.fromValue(100);
      const filledSizeResult = Quantity.fromValue(100);

      if (sizeResult.ok && filledSizeResult.ok) {
        const remaining = getRemainingSize(sizeResult.value, filledSizeResult.value);
        expect(remaining.value).toBe(0);
      }
    });

    it('should handle decimal sizes correctly', () => {
      const sizeResult = Quantity.fromValue(100.5);
      const filledSizeResult = Quantity.fromValue(30.2);

      if (sizeResult.ok && filledSizeResult.ok) {
        const remaining = getRemainingSize(sizeResult.value, filledSizeResult.value);
        expect(remaining.value).toBeCloseTo(70.3, 10);
      }
    });
  });

  describe('getFillPercentage()', () => {
    it('should return 0% for unfilled order', () => {
      const filledSizeResult = Quantity.fromValue(0);
      const sizeResult = Quantity.fromValue(100);

      if (filledSizeResult.ok && sizeResult.ok) {
        const percentage = getFillPercentage(filledSizeResult.value, sizeResult.value);
        expect(percentage.toNumber()).toBe(0);
      }
    });

    it('should calculate correct percentage', () => {
      const filledSizeResult = Quantity.fromValue(30);
      const sizeResult = Quantity.fromValue(100);

      if (filledSizeResult.ok && sizeResult.ok) {
        const percentage = getFillPercentage(filledSizeResult.value, sizeResult.value);
        expect(percentage.toNumber()).toBe(30);
      }
    });

    it('should return 100% for fully filled', () => {
      const filledSizeResult = Quantity.fromValue(100);
      const sizeResult = Quantity.fromValue(100);

      if (filledSizeResult.ok && sizeResult.ok) {
        const percentage = getFillPercentage(filledSizeResult.value, sizeResult.value);
        expect(percentage.toNumber()).toBe(100);
      }
    });

    it('should handle partial fills with decimals', () => {
      const filledSizeResult = Quantity.fromValue(33.33);
      const sizeResult = Quantity.fromValue(100);

      if (filledSizeResult.ok && sizeResult.ok) {
        const percentage = getFillPercentage(filledSizeResult.value, sizeResult.value);
        expect(percentage.toNumber()).toBeCloseTo(33.33, 2);
      }
    });

    it('should handle very small percentages', () => {
      const filledSizeResult = Quantity.fromValue(0.01);
      const sizeResult = Quantity.fromValue(1000);

      if (filledSizeResult.ok && sizeResult.ok) {
        const percentage = getFillPercentage(filledSizeResult.value, sizeResult.value);
        expect(percentage.toNumber()).toBeCloseTo(0.001, 10);
      }
    });
  });
});
