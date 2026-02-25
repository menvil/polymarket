/**
 * Тесты для calculation utils
 */

import { Quantity, Price } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import { getNotional, getRemainingSize, getFillPercentage } from '../../../src/utils/calculations';

describe('calculations', () => {
  describe('getNotional()', () => {
    it('should calculate notional as price * size', () => {
      const price = Price.of(new Decimal('0.65'));
      const size = Quantity.of(new Decimal('100'));

      const notional = getNotional(price, size);
      expect(notional.toNumber()).toBe(65);
    });

    it('should handle decimal precision correctly', () => {
      const price = Price.of(new Decimal('0.333333'));
      const size = Quantity.of(new Decimal('3'));

      const notional = getNotional(price, size);
      // 0.333333 * 3 = 0.999999
      expect(notional.toNumber()).toBeCloseTo(0.999999, 6);
    });

    it('should return zero for zero size', () => {
      const price = Price.of(new Decimal('0.65'));
      const size = Quantity.of(new Decimal('0'));

      const notional = getNotional(price, size);
      expect(notional.toNumber()).toBe(0);
    });
  });

  describe('getRemainingSize()', () => {
    it('should return full size when no fill', () => {
      const size = Quantity.of(new Decimal('100'));
      const filledSize = Quantity.of(new Decimal('0'));

      const remaining = getRemainingSize(size, filledSize);
      expect(remaining.value().toNumber()).toBe(100);
    });

    it('should calculate remaining as size - filledSize', () => {
      const size = Quantity.of(new Decimal('100'));
      const filledSize = Quantity.of(new Decimal('30'));

      const remaining = getRemainingSize(size, filledSize);
      expect(remaining.value().toNumber()).toBe(70);
    });

    it('should return zero when fully filled', () => {
      const size = Quantity.of(new Decimal('100'));
      const filledSize = Quantity.of(new Decimal('100'));

      const remaining = getRemainingSize(size, filledSize);
      expect(remaining.value().toNumber()).toBe(0);
    });

    it('should handle decimal sizes correctly', () => {
      const size = Quantity.of(new Decimal('100.5'));
      const filledSize = Quantity.of(new Decimal('30.2'));

      const remaining = getRemainingSize(size, filledSize);
      expect(remaining.value().toNumber()).toBeCloseTo(70.3, 10);
    });
  });

  describe('getFillPercentage()', () => {
    it('should return 0% for unfilled order', () => {
      const filledSize = Quantity.of(new Decimal('0'));
      const size = Quantity.of(new Decimal('100'));

      const percentage = getFillPercentage(filledSize, size);
      expect(percentage.toNumber()).toBe(0);
    });

    it('should calculate correct percentage', () => {
      const filledSize = Quantity.of(new Decimal('30'));
      const size = Quantity.of(new Decimal('100'));

      const percentage = getFillPercentage(filledSize, size);
      expect(percentage.toNumber()).toBe(30);
    });

    it('should return 100% for fully filled', () => {
      const filledSize = Quantity.of(new Decimal('100'));
      const size = Quantity.of(new Decimal('100'));

      const percentage = getFillPercentage(filledSize, size);
      expect(percentage.toNumber()).toBe(100);
    });

    it('should handle partial fills with decimals', () => {
      const filledSize = Quantity.of(new Decimal('33.33'));
      const size = Quantity.of(new Decimal('100'));

      const percentage = getFillPercentage(filledSize, size);
      expect(percentage.toNumber()).toBeCloseTo(33.33, 2);
    });

    it('should handle very small percentages', () => {
      const filledSize = Quantity.of(new Decimal('0.01'));
      const size = Quantity.of(new Decimal('1000'));

      const percentage = getFillPercentage(filledSize, size);
      expect(percentage.toNumber()).toBeCloseTo(0.001, 10);
    });
  });
});
