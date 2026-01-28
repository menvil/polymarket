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

  describe('строгое сравнение с нулем', () => {
    it('используйте встроенный метод isZero() для строгого сравнения', () => {
      expect(new Decimal(0).isZero()).toBe(true);
      expect(new Decimal('0').isZero()).toBe(true);
      expect(new Decimal('0.0').isZero()).toBe(true);

      expect(new Decimal('1e-11').isZero()).toBe(false);
      expect(new Decimal(0.0000001).isZero()).toBe(false);
    });

    it('для приблизительного сравнения используйте abs().lessThan()', () => {
      const value = new Decimal('0.0001');
      const epsilon = new Decimal('0.001');

      // Приблизительное: близко к нулю?
      expect(value.abs().lessThan(epsilon)).toBe(true);

      // Строгое: равно нулю?
      expect(value.isZero()).toBe(false);
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
      const zero = new Decimal(0);
      const epsilon = new Decimal('0.001');

      expect(isZeroDecimal(zero, epsilon)).toBe(true);
    });

    it('должен возвращать true для значений внутри epsilon', () => {
      const value = new Decimal('0.0005');
      const epsilon = new Decimal('0.001');

      expect(isZeroDecimal(value, epsilon)).toBe(true);
    });

    it('должен возвращать false для значений вне epsilon', () => {
      const value = new Decimal('0.002');
      const epsilon = new Decimal('0.001');

      expect(isZeroDecimal(value, epsilon)).toBe(false);
    });

    it('должен работать с отрицательными значениями', () => {
      const value = new Decimal('-0.0005');
      const epsilon = new Decimal('0.001');

      expect(isZeroDecimal(value, epsilon)).toBe(true);
    });

    it('должен работать с очень маленькими epsilon', () => {
      const value = new Decimal('1e-11');
      const highPrecision = new Decimal('1e-10');

      expect(isZeroDecimal(value, highPrecision)).toBe(true);
    });

    it('должен возвращать false когда значение вне высокой точности', () => {
      const value = new Decimal('1e-9');
      const highPrecision = new Decimal('1e-10');

      expect(isZeroDecimal(value, highPrecision)).toBe(false);
    });

    it('должен работать с разными epsilon для разных контекстов', () => {
      const diff = new Decimal('0.0001');

      // Высокая точность для числовых вычислений
      const computationalPrecision = new Decimal('1e-10');
      expect(isZeroDecimal(diff, computationalPrecision)).toBe(false);

      // Бизнес-точность (1 цент)
      const businessPrecision = new Decimal('0.01');
      expect(isZeroDecimal(diff, businessPrecision)).toBe(true);
    });

    it('отличие от строгого isZero()', () => {
      const value = new Decimal('0.0000001');

      // Строгое сравнение
      expect(value.isZero()).toBe(false);

      // Приблизительное сравнение
      const epsilon = new Decimal('0.000001');
      expect(isZeroDecimal(value, epsilon)).toBe(true);
    });

    it('граничный случай: значение равно epsilon', () => {
      const value = new Decimal('0.001');
      const epsilon = new Decimal('0.001');

      // |0.001| < 0.001 = false (не строго меньше)
      expect(isZeroDecimal(value, epsilon)).toBe(false);
    });

    it('граничный случай: значение чуть меньше epsilon', () => {
      const value = new Decimal('0.0009999');
      const epsilon = new Decimal('0.001');

      expect(isZeroDecimal(value, epsilon)).toBe(true);
    });
  });
});
