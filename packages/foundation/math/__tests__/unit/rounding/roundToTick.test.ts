import { describe, it, expect } from '@jest/globals';
import {
  roundToTick,
  floorToTick,
  ceilToTick,
  mathFloorToTick,
  mathCeilToTick,
} from '../../../src/rounding/roundToTick.js';
import { InvalidTickSizeError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('roundToTick', () => {
  describe('roundToTick (default ROUND_HALF_UP)', () => {
    it('должен округлять до 0.01', () => {
      const result = roundToTick(new Decimal(10.567), new Decimal(0.01));
      expect(result.toString()).toBe('10.57');
    });

    it('должен округлять до 0.1', () => {
      const result = roundToTick(new Decimal(10.567), new Decimal(0.1));
      expect(result.toString()).toBe('10.6');
    });

    it('должен округлять вниз когда .xx4', () => {
      const result = roundToTick(new Decimal(10.564), new Decimal(0.01));
      expect(result.toString()).toBe('10.56');
    });

    it('должен округлять вверх когда .xx5', () => {
      const result = roundToTick(new Decimal(10.565), new Decimal(0.01));
      expect(result.toString()).toBe('10.57');
    });

    it('должен округлять вверх когда .xx6', () => {
      const result = roundToTick(new Decimal(10.566), new Decimal(0.01));
      expect(result.toString()).toBe('10.57');
    });

    it('должен работать с большими числами', () => {
      const result = roundToTick(
        new Decimal('999999999999.567'),
        new Decimal(0.01)
      );
      expect(result.toString()).toBe('999999999999.57');
    });

    it('должен работать с очень маленькими числами', () => {
      const result = roundToTick(new Decimal('0.00567'), new Decimal(0.001));
      expect(result.toString()).toBe('0.006');
    });

    it('должен работать с tickSize = 1', () => {
      const result = roundToTick(new Decimal(10.5), new Decimal(1));
      expect(result.toString()).toBe('11');
    });

    it('должен работать с tickSize = 0.5', () => {
      const result = roundToTick(new Decimal(10.7), new Decimal(0.5));
      expect(result.toString()).toBe('10.5');
    });

    it('должен работать с tickSize = 5', () => {
      const result = roundToTick(new Decimal(12), new Decimal(5));
      expect(result.toString()).toBe('10');
    });

    it('должен не изменять уже округлённые значения', () => {
      const result = roundToTick(new Decimal(10.5), new Decimal(0.01));
      expect(result.toString()).toBe('10.5');
    });

    it('должен работать с отрицательными числами', () => {
      const result = roundToTick(new Decimal(-10.567), new Decimal(0.01));
      expect(result.toString()).toBe('-10.57');
    });
  });

  describe('floorToTick (ROUND_DOWN)', () => {
    it('должен округлять вниз для положительных', () => {
      const result = floorToTick(new Decimal(10.567), new Decimal(0.01));
      expect(result.toString()).toBe('10.56');
    });

    it('должен округлять к нулю для отрицательных', () => {
      const result = floorToTick(new Decimal(-10.567), new Decimal(0.01));
      expect(result.toString()).toBe('-10.56'); // К нулю!
    });

    it('должен работать с tickSize = 0.1', () => {
      const result = floorToTick(new Decimal(10.99), new Decimal(0.1));
      expect(result.toString()).toBe('10.9');
    });
  });

  describe('ceilToTick (ROUND_UP)', () => {
    it('должен округлять вверх для положительных', () => {
      const result = ceilToTick(new Decimal(10.561), new Decimal(0.01));
      expect(result.toString()).toBe('10.57');
    });

    it('должен округлять от нуля для отрицательных', () => {
      const result = ceilToTick(new Decimal(-10.561), new Decimal(0.01));
      expect(result.toString()).toBe('-10.57'); // От нуля!
    });

    it('должен работать с tickSize = 0.1', () => {
      const result = ceilToTick(new Decimal(10.01), new Decimal(0.1));
      expect(result.toString()).toBe('10.1');
    });
  });

  describe('mathFloorToTick (ROUND_FLOOR - к -Infinity)', () => {
    it('должен округлять вниз для положительных', () => {
      const result = mathFloorToTick(new Decimal(10.567), new Decimal(0.01));
      expect(result.toString()).toBe('10.56');
    });

    it('должен округлять к -Infinity для отрицательных', () => {
      const result = mathFloorToTick(new Decimal(-10.561), new Decimal(0.01));
      expect(result.toString()).toBe('-10.57'); // К -Infinity!
    });
  });

  describe('mathCeilToTick (ROUND_CEIL - к +Infinity)', () => {
    it('должен округлять вверх для положительных', () => {
      const result = mathCeilToTick(new Decimal(10.561), new Decimal(0.01));
      expect(result.toString()).toBe('10.57');
    });

    it('должен округлять к +Infinity для отрицательных', () => {
      const result = mathCeilToTick(new Decimal(-10.567), new Decimal(0.01));
      expect(result.toString()).toBe('-10.56'); // К +Infinity!
    });
  });

  describe('сравнение разных режимов округления', () => {
    it('разница между floor и mathFloor для отрицательных', () => {
      const value = new Decimal(-10.567);
      const tick = new Decimal(0.01);

      const floor = floorToTick(value, tick);
      const mathFloor = mathFloorToTick(value, tick);

      expect(floor.toString()).toBe('-10.56'); // К нулю
      expect(mathFloor.toString()).toBe('-10.57'); // К -Infinity
    });

    it('разница между ceil и mathCeil для отрицательных', () => {
      const value = new Decimal(-10.561);
      const tick = new Decimal(0.01);

      const ceil = ceilToTick(value, tick);
      const mathCeil = mathCeilToTick(value, tick);

      expect(ceil.toString()).toBe('-10.57'); // От нуля
      expect(mathCeil.toString()).toBe('-10.56'); // К +Infinity
    });
  });

  describe('ошибки валидации tickSize', () => {
    it('должен throw на tickSize <= 0', () => {
      expect(() => roundToTick(new Decimal(10), new Decimal(0))).toThrow(
        InvalidTickSizeError
      );
    });

    it('должен throw на отрицательный tickSize', () => {
      expect(() => roundToTick(new Decimal(10), new Decimal(-0.01))).toThrow(
        InvalidTickSizeError
      );
    });

    it('должен throw на tickSize = NaN', () => {
      expect(() => roundToTick(new Decimal(10), new Decimal(NaN))).toThrow(
        InvalidTickSizeError
      );
    });

    it('должен throw на tickSize = Infinity', () => {
      expect(() =>
        roundToTick(new Decimal(10), new Decimal(Infinity))
      ).toThrow(InvalidTickSizeError);
    });

    it('должен содержать контекст в ошибке', () => {
      try {
        roundToTick(new Decimal(10), new Decimal(0));
        fail('Should throw');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidTickSizeError);
        if (error instanceof InvalidTickSizeError) {
          expect(error.context).toBeDefined();
          expect(error.context?.tickSize).toBe('0');
          expect(error.context?.value).toBe('10');
        }
      }
    });
  });

  describe('точность и граничные случаи', () => {
    it('должен сохранять точность для очень маленьких tickSize', () => {
      const result = roundToTick(
        new Decimal('1.123456789'),
        new Decimal('0.000000001')
      );
      expect(result.toString()).toBe('1.123456789');
    });

    it('должен корректно работать с большим tickSize', () => {
      const result = roundToTick(new Decimal(123), new Decimal(50));
      expect(result.toString()).toBe('100');
    });

    it('должен работать с нулевым значением', () => {
      const result = roundToTick(new Decimal(0), new Decimal(0.01));
      expect(result.toString()).toBe('0');
    });
  });
});
