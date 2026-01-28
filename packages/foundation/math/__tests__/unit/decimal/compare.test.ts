import { describe, it, expect } from '@jest/globals';
import {
  equalsDecimal,
  lessThanDecimal,
  lessThanOrEqualDecimal,
  greaterThanDecimal,
  greaterThanOrEqualDecimal,
  compareDecimal,
} from '../../../src/decimal/compare.js';
import Decimal from 'decimal.js';

describe('compare', () => {
  describe('equalsDecimal', () => {
    it('должен возвращать true для одинаковых чисел', () => {
      expect(equalsDecimal(new Decimal(10), new Decimal(10))).toBe(true);
    });

    it('должен возвращать true для чисел в пределах epsilon', () => {
      const a = new Decimal(10);
      const b = new Decimal('10.00000000001'); // Разница < 1e-10
      expect(equalsDecimal(a, b)).toBe(true);
    });

    it('должен возвращать false для разных чисел', () => {
      expect(equalsDecimal(new Decimal(10), new Decimal(11))).toBe(false);
    });

    it('должен работать с отрицательными числами', () => {
      expect(equalsDecimal(new Decimal(-10), new Decimal(-10))).toBe(true);
    });

    it('должен работать с кастомным epsilon', () => {
      const a = new Decimal(10);
      const b = new Decimal(10.5);
      const epsilon = new Decimal(1);
      expect(equalsDecimal(a, b, epsilon)).toBe(true);
    });

    it('должен возвращать true для нуля', () => {
      expect(equalsDecimal(new Decimal(0), new Decimal(0))).toBe(true);
    });
  });

  describe('lessThanDecimal', () => {
    it('должен возвращать true когда a < b', () => {
      expect(lessThanDecimal(new Decimal(5), new Decimal(10))).toBe(true);
    });

    it('должен возвращать false когда a >= b', () => {
      expect(lessThanDecimal(new Decimal(10), new Decimal(10))).toBe(false);
      expect(lessThanDecimal(new Decimal(15), new Decimal(10))).toBe(false);
    });

    it('должен работать с отрицательными числами', () => {
      expect(lessThanDecimal(new Decimal(-10), new Decimal(-5))).toBe(true);
    });

    it('должен работать с дробными числами', () => {
      expect(lessThanDecimal(new Decimal(1.5), new Decimal(1.6))).toBe(true);
    });
  });

  describe('lessThanOrEqualDecimal', () => {
    it('должен возвращать true когда a < b', () => {
      expect(lessThanOrEqualDecimal(new Decimal(5), new Decimal(10))).toBe(
        true
      );
    });

    it('должен возвращать true когда a == b', () => {
      expect(lessThanOrEqualDecimal(new Decimal(10), new Decimal(10))).toBe(
        true
      );
    });

    it('должен возвращать false когда a > b', () => {
      expect(lessThanOrEqualDecimal(new Decimal(15), new Decimal(10))).toBe(
        false
      );
    });
  });

  describe('greaterThanDecimal', () => {
    it('должен возвращать true когда a > b', () => {
      expect(greaterThanDecimal(new Decimal(10), new Decimal(5))).toBe(true);
    });

    it('должен возвращать false когда a <= b', () => {
      expect(greaterThanDecimal(new Decimal(10), new Decimal(10))).toBe(false);
      expect(greaterThanDecimal(new Decimal(5), new Decimal(10))).toBe(false);
    });

    it('должен работать с отрицательными числами', () => {
      expect(greaterThanDecimal(new Decimal(-5), new Decimal(-10))).toBe(true);
    });
  });

  describe('greaterThanOrEqualDecimal', () => {
    it('должен возвращать true когда a > b', () => {
      expect(greaterThanOrEqualDecimal(new Decimal(10), new Decimal(5))).toBe(
        true
      );
    });

    it('должен возвращать true когда a == b', () => {
      expect(greaterThanOrEqualDecimal(new Decimal(10), new Decimal(10))).toBe(
        true
      );
    });

    it('должен возвращать false когда a < b', () => {
      expect(greaterThanOrEqualDecimal(new Decimal(5), new Decimal(10))).toBe(
        false
      );
    });
  });

  describe('compareDecimal', () => {
    it('должен возвращать -1 когда a < b', () => {
      expect(compareDecimal(new Decimal(5), new Decimal(10))).toBe(-1);
    });

    it('должен возвращать 0 когда a == b', () => {
      expect(compareDecimal(new Decimal(10), new Decimal(10))).toBe(0);
    });

    it('должен возвращать 1 когда a > b', () => {
      expect(compareDecimal(new Decimal(15), new Decimal(10))).toBe(1);
    });

    it('должен работать с отрицательными числами', () => {
      expect(compareDecimal(new Decimal(-10), new Decimal(-5))).toBe(-1);
      expect(compareDecimal(new Decimal(-5), new Decimal(-10))).toBe(1);
    });

    it('должен работать с нулём', () => {
      expect(compareDecimal(new Decimal(0), new Decimal(0))).toBe(0);
      expect(compareDecimal(new Decimal(5), new Decimal(0))).toBe(1);
      expect(compareDecimal(new Decimal(-5), new Decimal(0))).toBe(-1);
    });
  });

  describe('транзитивность сравнений', () => {
    it('если a < b и b < c, то a < c', () => {
      const a = new Decimal(1);
      const b = new Decimal(5);
      const c = new Decimal(10);

      expect(lessThanDecimal(a, b)).toBe(true);
      expect(lessThanDecimal(b, c)).toBe(true);
      expect(lessThanDecimal(a, c)).toBe(true);
    });

    it('если a == b и b == c, то a == c', () => {
      const a = new Decimal(10);
      const b = new Decimal(10);
      const c = new Decimal(10);

      expect(equalsDecimal(a, b)).toBe(true);
      expect(equalsDecimal(b, c)).toBe(true);
      expect(equalsDecimal(a, c)).toBe(true);
    });
  });
});
