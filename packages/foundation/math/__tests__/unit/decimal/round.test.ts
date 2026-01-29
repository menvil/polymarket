import { describe, it, expect } from '@jest/globals';
import {
  roundDecimal,
  roundTowardZeroDecimal,
  roundAwayFromZeroDecimal,
  truncDecimal,
  mathFloorDecimal,
  mathCeilDecimal,
} from '../../../src/decimal/round.js';
import Decimal from 'decimal.js';
import { InvalidOperandError } from '@polymarket/errors';

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

  describe('roundTowardZeroDecimal (ROUND_DOWN - к нулю)', () => {
    it('должен округлять положительные вниз (к нулю)', () => {
      expect(roundTowardZeroDecimal(new Decimal(10.9)).toString()).toBe('10');
      expect(roundTowardZeroDecimal(new Decimal(10.1)).toString()).toBe('10');
    });

    it('должен округлять отрицательные вверх (к нулю)', () => {
      expect(roundTowardZeroDecimal(new Decimal(-10.9)).toString()).toBe('-10');
      expect(roundTowardZeroDecimal(new Decimal(-10.1)).toString()).toBe('-10');
    });

    it('должен не изменять целые числа', () => {
      expect(roundTowardZeroDecimal(new Decimal(10)).toString()).toBe('10');
      expect(roundTowardZeroDecimal(new Decimal(-10)).toString()).toBe('-10');
    });

    it('должен работать с нулём', () => {
      expect(roundTowardZeroDecimal(new Decimal(0)).toString()).toBe('0');
    });
  });

  describe('roundAwayFromZeroDecimal (ROUND_UP - от нуля)', () => {
    it('должен округлять положительные вверх (от нуля)', () => {
      expect(roundAwayFromZeroDecimal(new Decimal(10.1)).toString()).toBe('11');
      expect(roundAwayFromZeroDecimal(new Decimal(10.9)).toString()).toBe('11');
    });

    it('должен округлять отрицательные вниз (от нуля)', () => {
      expect(roundAwayFromZeroDecimal(new Decimal(-10.1)).toString()).toBe('-11');
      expect(roundAwayFromZeroDecimal(new Decimal(-10.9)).toString()).toBe('-11');
    });

    it('должен не изменять целые числа', () => {
      expect(roundAwayFromZeroDecimal(new Decimal(10)).toString()).toBe('10');
      expect(roundAwayFromZeroDecimal(new Decimal(-10)).toString()).toBe('-10');
    });

    it('должен работать с нулём', () => {
      expect(roundAwayFromZeroDecimal(new Decimal(0)).toString()).toBe('0');
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
      expect(roundTowardZeroDecimal(value).toString()).toBe('10'); // К нулю
      expect(roundAwayFromZeroDecimal(value).toString()).toBe('11'); // От нуля
      expect(roundDecimal(value).toString()).toBe('11'); // Half-up
    });

    it('roundTowardZeroDecimal (к нулю) vs mathFloorDecimal (к -Infinity) для отрицательных', () => {
      expect(roundTowardZeroDecimal(new Decimal(-10.1)).toString()).toBe('-10'); // К нулю
      expect(mathFloorDecimal(new Decimal(-10.1)).toString()).toBe('-11'); // К -Infinity
    });

    it('roundAwayFromZeroDecimal (от нуля) vs mathCeilDecimal (к +Infinity) для отрицательных', () => {
      expect(roundAwayFromZeroDecimal(new Decimal(-10.9)).toString()).toBe('-11'); // От нуля
      expect(mathCeilDecimal(new Decimal(-10.9)).toString()).toBe('-10'); // К +Infinity
    });

    it('floor и trunc одинаковы для положительных', () => {
      const value = new Decimal(10.7);
      expect(roundTowardZeroDecimal(value).toString()).toBe(
        truncDecimal(value).toString()
      );
    });

    it('floor и trunc одинаковы для отрицательных (оба к нулю)', () => {
      const value = new Decimal(-10.7);
      expect(roundTowardZeroDecimal(value).toString()).toBe(
        truncDecimal(value).toString()
      );
    });

    it('truncDecimal отличается от mathFloorDecimal для отрицательных', () => {
      expect(truncDecimal(new Decimal(-10.9)).toString()).toBe('-10'); // К нулю
      expect(mathFloorDecimal(new Decimal(-10.9)).toString()).toBe('-11'); // К -Infinity
    });
  });

  describe('валидация операндов', () => {
    describe('roundDecimal', () => {
      it('должен throw InvalidOperandError на NaN', () => {
        expect(() => roundDecimal(new Decimal(NaN))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на Infinity', () => {
        expect(() => roundDecimal(new Decimal(Infinity))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на -Infinity', () => {
        expect(() => roundDecimal(new Decimal(-Infinity))).toThrow(InvalidOperandError);
      });

      it('должен содержать контекст в InvalidOperandError', () => {
        expect.assertions(4);
        try {
          roundDecimal(new Decimal(NaN));
        } catch (error) {
          expect(InvalidOperandError.is(error)).toBe(true);
          if (InvalidOperandError.is(error)) {
            expect(error.context).toBeDefined();
            expect(error.context?.value).toBe('NaN');
            expect(error.context?.operation).toBe('round');
          }
        }
      });
    });

    describe('roundTowardZeroDecimal', () => {
      it('должен throw InvalidOperandError на NaN', () => {
        expect(() => roundTowardZeroDecimal(new Decimal(NaN))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на Infinity', () => {
        expect(() => roundTowardZeroDecimal(new Decimal(Infinity))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на -Infinity', () => {
        expect(() => roundTowardZeroDecimal(new Decimal(-Infinity))).toThrow(InvalidOperandError);
      });

      it('должен содержать контекст в InvalidOperandError', () => {
        expect.assertions(4);
        try {
          roundTowardZeroDecimal(new Decimal(Infinity));
        } catch (error) {
          expect(InvalidOperandError.is(error)).toBe(true);
          if (InvalidOperandError.is(error)) {
            expect(error.context).toBeDefined();
            expect(error.context?.value).toBe('Infinity');
            expect(error.context?.operation).toBe('roundTowardZero');
          }
        }
      });
    });

    describe('roundAwayFromZeroDecimal', () => {
      it('должен throw InvalidOperandError на NaN', () => {
        expect(() => roundAwayFromZeroDecimal(new Decimal(NaN))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на Infinity', () => {
        expect(() => roundAwayFromZeroDecimal(new Decimal(Infinity))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на -Infinity', () => {
        expect(() => roundAwayFromZeroDecimal(new Decimal(-Infinity))).toThrow(InvalidOperandError);
      });

      it('должен содержать контекст в InvalidOperandError', () => {
        expect.assertions(4);
        try {
          roundAwayFromZeroDecimal(new Decimal(-Infinity));
        } catch (error) {
          expect(InvalidOperandError.is(error)).toBe(true);
          if (InvalidOperandError.is(error)) {
            expect(error.context).toBeDefined();
            expect(error.context?.value).toBe('-Infinity');
            expect(error.context?.operation).toBe('roundAwayFromZero');
          }
        }
      });
    });

    describe('truncDecimal', () => {
      it('должен throw InvalidOperandError на NaN', () => {
        expect(() => truncDecimal(new Decimal(NaN))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на Infinity', () => {
        expect(() => truncDecimal(new Decimal(Infinity))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на -Infinity', () => {
        expect(() => truncDecimal(new Decimal(-Infinity))).toThrow(InvalidOperandError);
      });

      it('должен содержать контекст в InvalidOperandError', () => {
        expect.assertions(4);
        try {
          truncDecimal(new Decimal(NaN));
        } catch (error) {
          expect(InvalidOperandError.is(error)).toBe(true);
          if (InvalidOperandError.is(error)) {
            expect(error.context).toBeDefined();
            expect(error.context?.value).toBe('NaN');
            expect(error.context?.operation).toBe('trunc');
          }
        }
      });
    });

    describe('mathFloorDecimal', () => {
      it('должен throw InvalidOperandError на NaN', () => {
        expect(() => mathFloorDecimal(new Decimal(NaN))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на Infinity', () => {
        expect(() => mathFloorDecimal(new Decimal(Infinity))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на -Infinity', () => {
        expect(() => mathFloorDecimal(new Decimal(-Infinity))).toThrow(InvalidOperandError);
      });

      it('должен содержать контекст в InvalidOperandError', () => {
        expect.assertions(4);
        try {
          mathFloorDecimal(new Decimal(Infinity));
        } catch (error) {
          expect(InvalidOperandError.is(error)).toBe(true);
          if (InvalidOperandError.is(error)) {
            expect(error.context).toBeDefined();
            expect(error.context?.value).toBe('Infinity');
            expect(error.context?.operation).toBe('mathFloor');
          }
        }
      });
    });

    describe('mathCeilDecimal', () => {
      it('должен throw InvalidOperandError на NaN', () => {
        expect(() => mathCeilDecimal(new Decimal(NaN))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на Infinity', () => {
        expect(() => mathCeilDecimal(new Decimal(Infinity))).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на -Infinity', () => {
        expect(() => mathCeilDecimal(new Decimal(-Infinity))).toThrow(InvalidOperandError);
      });

      it('должен содержать контекст в InvalidOperandError', () => {
        expect.assertions(4);
        try {
          mathCeilDecimal(new Decimal(-Infinity));
        } catch (error) {
          expect(InvalidOperandError.is(error)).toBe(true);
          if (InvalidOperandError.is(error)) {
            expect(error.context).toBeDefined();
            expect(error.context?.value).toBe('-Infinity');
            expect(error.context?.operation).toBe('mathCeil');
          }
        }
      });
    });
  });
});
