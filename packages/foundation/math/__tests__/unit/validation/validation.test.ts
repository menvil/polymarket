import { describe, it, expect } from '@jest/globals';
import {
  isFiniteDecimal,
  isPositiveDecimal,
  isNonNegativeDecimal,
  isZeroDecimal,
} from '../../../src/validation/index.js';
import Decimal from 'decimal.js';

describe('validation', () => {
  describe('isFiniteDecimal', () => {
    it('должен возвращать true для конечных чисел', () => {
      expect(isFiniteDecimal(new Decimal(10))).toBe(true);
      expect(isFiniteDecimal(new Decimal(-10))).toBe(true);
      expect(isFiniteDecimal(new Decimal(0))).toBe(true);
      expect(isFiniteDecimal(new Decimal(1.5))).toBe(true);
    });

    it('должен возвращать false для NaN', () => {
      expect(isFiniteDecimal(new Decimal(NaN))).toBe(false);
    });

    it('должен возвращать false для Infinity', () => {
      expect(isFiniteDecimal(new Decimal(Infinity))).toBe(false);
      expect(isFiniteDecimal(new Decimal(-Infinity))).toBe(false);
    });
  });

  describe('isPositiveDecimal', () => {
    it('должен возвращать true для положительных чисел', () => {
      expect(isPositiveDecimal(new Decimal(10))).toBe(true);
      expect(isPositiveDecimal(new Decimal(0.1))).toBe(true);
      expect(isPositiveDecimal(new Decimal('1e-10'))).toBe(true);
    });

    it('должен возвращать false для нуля', () => {
      expect(isPositiveDecimal(new Decimal(0))).toBe(false);
    });

    it('должен возвращать false для отрицательных', () => {
      expect(isPositiveDecimal(new Decimal(-10))).toBe(false);
      expect(isPositiveDecimal(new Decimal(-0.1))).toBe(false);
    });
  });

  describe('isNonNegativeDecimal', () => {
    it('должен возвращать true для положительных чисел', () => {
      expect(isNonNegativeDecimal(new Decimal(10))).toBe(true);
      expect(isNonNegativeDecimal(new Decimal(0.1))).toBe(true);
    });

    it('должен возвращать true для нуля', () => {
      expect(isNonNegativeDecimal(new Decimal(0))).toBe(true);
    });

    it('должен возвращать false для отрицательных', () => {
      expect(isNonNegativeDecimal(new Decimal(-10))).toBe(false);
      expect(isNonNegativeDecimal(new Decimal(-0.1))).toBe(false);
    });
  });

  describe('граничные случаи', () => {
    it('isPositive и isNonNegative различаются только для нуля', () => {
      const zero = new Decimal(0);
      expect(isPositiveDecimal(zero)).toBe(false);
      expect(isNonNegativeDecimal(zero)).toBe(true);

      const positive = new Decimal(10);
      expect(isPositiveDecimal(positive)).toBe(true);
      expect(isNonNegativeDecimal(positive)).toBe(true);

      const negative = new Decimal(-10);
      expect(isPositiveDecimal(negative)).toBe(false);
      expect(isNonNegativeDecimal(negative)).toBe(false);
    });
  });

  describe('isZeroDecimal', () => {
    it('должен возвращать true для строгого нуля', () => {
      expect(isZeroDecimal(new Decimal(0))).toBe(true);
      expect(isZeroDecimal(new Decimal('0'))).toBe(true);
      expect(isZeroDecimal(new Decimal('0.0'))).toBe(true);
      expect(isZeroDecimal(new Decimal('-0'))).toBe(true);
    });

    it('должен возвращать false для ненулевых значений', () => {
      expect(isZeroDecimal(new Decimal('0.0001'))).toBe(false);
      expect(isZeroDecimal(new Decimal('1e-10'))).toBe(false);
      expect(isZeroDecimal(new Decimal('-0.0001'))).toBe(false);
      expect(isZeroDecimal(new Decimal(1))).toBe(false);
      expect(isZeroDecimal(new Decimal(-1))).toBe(false);
    });

    it('isZeroDecimal использует строгое равенство (не approximate)', () => {
      const almostZero = new Decimal('1e-10');

      // Строгое: ненулевое значение возвращает false
      expect(isZeroDecimal(almostZero)).toBe(false);

      // Строгое: только настоящий 0 возвращает true
      expect(isZeroDecimal(new Decimal(0))).toBe(true);
    });
  });
});
