import { describe, it, expect } from '@jest/globals';
import {
  roundDecimal,
  floorDecimal,
  ceilDecimal,
  truncDecimal,
  mathFloorDecimal,
  mathCeilDecimal,
} from '../../../src/decimal/round.js';
import Decimal from 'decimal.js';

describe('round', () => {
  describe('roundDecimal (ROUND_HALF_UP)', () => {
    it('должен округлять 0.5 вверх', () => {
      expect(roundDecimal(new Decimal(10.5)).toString()).toBe('11');
    });

    it('должен округлять 0.4 вниз', () => {
      expect(roundDecimal(new Decimal(10.4)).toString()).toBe('10');
    });

    it('должен округлять 0.6 вверх', () => {
      expect(roundDecimal(new Decimal(10.6)).toString()).toBe('11');
    });

    it('должен работать с отрицательными числами', () => {
      expect(roundDecimal(new Decimal(-10.5)).toString()).toBe('-11');
      expect(roundDecimal(new Decimal(-10.4)).toString()).toBe('-10');
    });

    it('должен не изменять целые числа', () => {
      expect(roundDecimal(new Decimal(10)).toString()).toBe('10');
    });

    it('должен работать с нулём', () => {
      expect(roundDecimal(new Decimal(0)).toString()).toBe('0');
    });

    it('должен работать с очень маленькими числами', () => {
      expect(roundDecimal(new Decimal(0.1)).toString()).toBe('0');
      expect(roundDecimal(new Decimal(0.9)).toString()).toBe('1');
    });
  });

  describe('floorDecimal (ROUND_DOWN - к нулю)', () => {
    it('должен округлять положительные вниз (к нулю)', () => {
      expect(floorDecimal(new Decimal(10.9)).toString()).toBe('10');
      expect(floorDecimal(new Decimal(10.1)).toString()).toBe('10');
    });

    it('должен округлять отрицательные вверх (к нулю)', () => {
      expect(floorDecimal(new Decimal(-10.9)).toString()).toBe('-10');
      expect(floorDecimal(new Decimal(-10.1)).toString()).toBe('-10');
    });

    it('должен не изменять целые числа', () => {
      expect(floorDecimal(new Decimal(10)).toString()).toBe('10');
      expect(floorDecimal(new Decimal(-10)).toString()).toBe('-10');
    });

    it('должен работать с нулём', () => {
      expect(floorDecimal(new Decimal(0)).toString()).toBe('0');
    });
  });

  describe('ceilDecimal (ROUND_UP - от нуля)', () => {
    it('должен округлять положительные вверх (от нуля)', () => {
      expect(ceilDecimal(new Decimal(10.1)).toString()).toBe('11');
      expect(ceilDecimal(new Decimal(10.9)).toString()).toBe('11');
    });

    it('должен округлять отрицательные вниз (от нуля)', () => {
      expect(ceilDecimal(new Decimal(-10.1)).toString()).toBe('-11');
      expect(ceilDecimal(new Decimal(-10.9)).toString()).toBe('-11');
    });

    it('должен не изменять целые числа', () => {
      expect(ceilDecimal(new Decimal(10)).toString()).toBe('10');
      expect(ceilDecimal(new Decimal(-10)).toString()).toBe('-10');
    });

    it('должен работать с нулём', () => {
      expect(ceilDecimal(new Decimal(0)).toString()).toBe('0');
    });
  });

  describe('truncDecimal', () => {
    it('должен отбрасывать дробную часть положительных', () => {
      expect(truncDecimal(new Decimal(10.9)).toString()).toBe('10');
      expect(truncDecimal(new Decimal(10.1)).toString()).toBe('10');
    });

    it('должен отбрасывать дробную часть отрицательных', () => {
      expect(truncDecimal(new Decimal(-10.9)).toString()).toBe('-10');
      expect(truncDecimal(new Decimal(-10.1)).toString()).toBe('-10');
    });

    it('должен не изменять целые числа', () => {
      expect(truncDecimal(new Decimal(10)).toString()).toBe('10');
    });

    it('должен работать с нулём', () => {
      expect(truncDecimal(new Decimal(0)).toString()).toBe('0');
    });
  });

  describe('mathFloorDecimal (ROUND_FLOOR - к -Infinity)', () => {
    it('должен округлять положительные вниз', () => {
      expect(mathFloorDecimal(new Decimal(10.9)).toString()).toBe('10');
      expect(mathFloorDecimal(new Decimal(10.1)).toString()).toBe('10');
    });

    it('должен округлять отрицательные вниз (к -Infinity)', () => {
      expect(mathFloorDecimal(new Decimal(-10.1)).toString()).toBe('-11');
      expect(mathFloorDecimal(new Decimal(-10.9)).toString()).toBe('-11');
    });

    it('должен не изменять целые числа', () => {
      expect(mathFloorDecimal(new Decimal(10)).toString()).toBe('10');
      expect(mathFloorDecimal(new Decimal(-10)).toString()).toBe('-10');
    });

    it('должен работать с нулём', () => {
      expect(mathFloorDecimal(new Decimal(0)).toString()).toBe('0');
    });
  });

  describe('mathCeilDecimal (ROUND_CEIL - к +Infinity)', () => {
    it('должен округлять положительные вверх (к +Infinity)', () => {
      expect(mathCeilDecimal(new Decimal(10.1)).toString()).toBe('11');
      expect(mathCeilDecimal(new Decimal(10.9)).toString()).toBe('11');
    });

    it('должен округлять отрицательные вверх (к +Infinity)', () => {
      expect(mathCeilDecimal(new Decimal(-10.9)).toString()).toBe('-10');
      expect(mathCeilDecimal(new Decimal(-10.1)).toString()).toBe('-10');
    });

    it('должен не изменять целые числа', () => {
      expect(mathCeilDecimal(new Decimal(10)).toString()).toBe('10');
      expect(mathCeilDecimal(new Decimal(-10)).toString()).toBe('-10');
    });

    it('должен работать с нулём', () => {
      expect(mathCeilDecimal(new Decimal(0)).toString()).toBe('0');
    });
  });

  describe('сравнение методов округления', () => {
    it('floor, ceil и round дают разные результаты для 10.5', () => {
      const value = new Decimal(10.5);
      expect(floorDecimal(value).toString()).toBe('10'); // К нулю
      expect(ceilDecimal(value).toString()).toBe('11'); // От нуля
      expect(roundDecimal(value).toString()).toBe('11'); // Half-up
    });

    it('floorDecimal (к нулю) vs mathFloorDecimal (к -Infinity) для отрицательных', () => {
      expect(floorDecimal(new Decimal(-10.1)).toString()).toBe('-10'); // К нулю
      expect(mathFloorDecimal(new Decimal(-10.1)).toString()).toBe('-11'); // К -Infinity
    });

    it('ceilDecimal (от нуля) vs mathCeilDecimal (к +Infinity) для отрицательных', () => {
      expect(ceilDecimal(new Decimal(-10.9)).toString()).toBe('-11'); // От нуля
      expect(mathCeilDecimal(new Decimal(-10.9)).toString()).toBe('-10'); // К +Infinity
    });

    it('floor и trunc одинаковы для положительных', () => {
      const value = new Decimal(10.7);
      expect(floorDecimal(value).toString()).toBe(
        truncDecimal(value).toString()
      );
    });

    it('floor и trunc одинаковы для отрицательных (оба к нулю)', () => {
      const value = new Decimal(-10.7);
      expect(floorDecimal(value).toString()).toBe(
        truncDecimal(value).toString()
      );
    });

    it('truncDecimal отличается от mathFloorDecimal для отрицательных', () => {
      expect(truncDecimal(new Decimal(-10.9)).toString()).toBe('-10'); // К нулю
      expect(mathFloorDecimal(new Decimal(-10.9)).toString()).toBe('-11'); // К -Infinity
    });
  });
});
