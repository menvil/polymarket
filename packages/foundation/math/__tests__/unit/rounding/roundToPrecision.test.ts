import { describe, it, expect } from '@jest/globals';
import { roundToPrecision } from '../../../src/rounding/roundToPrecision.js';
import Decimal from 'decimal.js';

describe('roundToPrecision', () => {
  describe('normal operations', () => {
    it('должен округлять до 2 десятичных знаков', () => {
      const result = roundToPrecision(
        new Decimal('10.567'),
        2,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('10.57');
    });

    it('должен округлять до 1 десятичного знака', () => {
      const result = roundToPrecision(
        new Decimal('10.567'),
        1,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('10.6');
    });

    it('должен округлять до целого числа', () => {
      const result = roundToPrecision(
        new Decimal('10.5'),
        0,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('11');
    });

    it('должен работать с отрицательными числами', () => {
      const result = roundToPrecision(
        new Decimal('-10.567'),
        2,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('-10.57');
    });

    it('должен работать с большими числами', () => {
      const result = roundToPrecision(
        new Decimal('999999999999.567'),
        2,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('999999999999.57');
    });

    it('должен работать с очень маленькими числами', () => {
      const result = roundToPrecision(
        new Decimal('0.00567'),
        3,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('0.006');
    });

    it('должен не изменять уже округлённые значения', () => {
      const result = roundToPrecision(
        new Decimal('10.50'),
        2,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('10.5');
    });
  });

  describe('rounding modes', () => {
    it('ROUND_HALF_UP: должен округлять .5 вверх', () => {
      const result = roundToPrecision(
        new Decimal('10.565'),
        2,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('10.57');
    });

    it('ROUND_DOWN: должен округлять к нулю', () => {
      const result = roundToPrecision(
        new Decimal('10.567'),
        2,
        Decimal.ROUND_DOWN
      );
      expect(result.toString()).toBe('10.56');
    });

    it('ROUND_DOWN: должен округлять к нулю для отрицательных', () => {
      const result = roundToPrecision(
        new Decimal('-10.567'),
        2,
        Decimal.ROUND_DOWN
      );
      expect(result.toString()).toBe('-10.56'); // К нулю
    });

    it('ROUND_UP: должен округлять от нуля', () => {
      const result = roundToPrecision(
        new Decimal('10.561'),
        2,
        Decimal.ROUND_UP
      );
      expect(result.toString()).toBe('10.57');
    });

    it('ROUND_UP: должен округлять от нуля для отрицательных', () => {
      const result = roundToPrecision(
        new Decimal('-10.561'),
        2,
        Decimal.ROUND_UP
      );
      expect(result.toString()).toBe('-10.57'); // От нуля
    });

    it('ROUND_FLOOR: должен округлять к -Infinity', () => {
      const result = roundToPrecision(
        new Decimal('-10.561'),
        2,
        Decimal.ROUND_FLOOR
      );
      expect(result.toString()).toBe('-10.57'); // К -Infinity
    });

    it('ROUND_CEIL: должен округлять к +Infinity', () => {
      const result = roundToPrecision(
        new Decimal('-10.567'),
        2,
        Decimal.ROUND_CEIL
      );
      expect(result.toString()).toBe('-10.56'); // К +Infinity
    });
  });

  describe('edge cases', () => {
    it('должен работать с нулевым значением', () => {
      const result = roundToPrecision(new Decimal(0), 2, Decimal.ROUND_HALF_UP);
      expect(result.toString()).toBe('0');
    });

    it('должен работать с decimalPlaces = 0', () => {
      const result = roundToPrecision(
        new Decimal('10.9'),
        0,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('11');
    });

    it('должен работать с большим количеством знаков', () => {
      const result = roundToPrecision(
        new Decimal('10.123456789'),
        8,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('10.12345679');
    });
  });

  describe('валидация decimalPlaces', () => {
    it('должен throw Error на decimalPlaces < 0', () => {
      expect(() =>
        roundToPrecision(new Decimal('10.567'), -1, Decimal.ROUND_HALF_UP)
      ).toThrow(Error);
      expect(() =>
        roundToPrecision(new Decimal('10.567'), -1, Decimal.ROUND_HALF_UP)
      ).toThrow('Invalid argument');
    });

    it('должен throw Error на decimalPlaces = Infinity', () => {
      expect(() =>
        roundToPrecision(new Decimal('10.567'), Infinity, Decimal.ROUND_HALF_UP)
      ).toThrow(Error);
      expect(() =>
        roundToPrecision(new Decimal('10.567'), Infinity, Decimal.ROUND_HALF_UP)
      ).toThrow('Invalid argument');
    });

    it('должен throw Error на decimalPlaces = NaN', () => {
      expect(() =>
        roundToPrecision(new Decimal('10.567'), NaN, Decimal.ROUND_HALF_UP)
      ).toThrow(Error);
      expect(() =>
        roundToPrecision(new Decimal('10.567'), NaN, Decimal.ROUND_HALF_UP)
      ).toThrow('Invalid argument');
    });

    it('должен работать с очень высокой точностью', () => {
      const result = roundToPrecision(
        new Decimal('1.123456789012345'),
        15,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('1.123456789012345');
    });
  });

  describe('precision', () => {
    it('должен сохранять точность для больших чисел', () => {
      const value = new Decimal('123456789.123456789');
      const result = roundToPrecision(value, 5, Decimal.ROUND_HALF_UP);
      expect(result.toString()).toBe('123456789.12346');
    });
  });
});
