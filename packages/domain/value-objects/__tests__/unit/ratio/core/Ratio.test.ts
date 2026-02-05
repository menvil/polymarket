import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Ratio } from '../../../../src/ratio/core/Ratio';
import { RatioInvariantViolation } from '../../../../src/ratio/core/RatioInvariantViolation';
import { RatioErrorReason } from '../../../../src/ratio/errors/RatioErrorReason';

describe('Ratio core', () => {
  describe('инварианты', () => {
    it('NAN - бросает RatioInvariantViolation', () => {
      expect(() => {
        Ratio.of(new Decimal(NaN));
      }).toThrow(RatioInvariantViolation);

      try {
        Ratio.of(new Decimal(NaN));
      } catch (error) {
        expect(error).toBeInstanceOf(RatioInvariantViolation);
        expect((error as RatioInvariantViolation).reason).toBe(RatioErrorReason.NAN);
      }
    });

    it('NON_FINITE (Infinity) - бросает RatioInvariantViolation', () => {
      expect(() => {
        Ratio.of(new Decimal(Infinity));
      }).toThrow(RatioInvariantViolation);

      try {
        Ratio.of(new Decimal(Infinity));
      } catch (error) {
        expect(error).toBeInstanceOf(RatioInvariantViolation);
        expect((error as RatioInvariantViolation).reason).toBe(RatioErrorReason.NON_FINITE);
      }
    });

    it('NON_FINITE (-Infinity) - бросает RatioInvariantViolation', () => {
      expect(() => {
        Ratio.of(new Decimal(-Infinity));
      }).toThrow(RatioInvariantViolation);

      try {
        Ratio.of(new Decimal(-Infinity));
      } catch (error) {
        expect(error).toBeInstanceOf(RatioInvariantViolation);
        expect((error as RatioInvariantViolation).reason).toBe(RatioErrorReason.NON_FINITE);
      }
    });
  });

  describe('Ratio.of() success', () => {
    it('создает из положительного значения', () => {
      const ratio = Ratio.of(new Decimal(0.02));
      expect(ratio).toBeInstanceOf(Ratio);
      expect(ratio.toDecimal().toString()).toBe('0.02');
    });

    it('создает из отрицательного значения', () => {
      const ratio = Ratio.of(new Decimal(-0.1));
      expect(ratio).toBeInstanceOf(Ratio);
      expect(ratio.toDecimal().toString()).toBe('-0.1');
    });

    it('создает нулевой Ratio', () => {
      const ratio = Ratio.of(new Decimal(0));
      expect(ratio).toBeInstanceOf(Ratio);
      expect(ratio.toDecimal().toString()).toBe('0');
    });

    it('создает из дроби 0.5 (50%)', () => {
      const ratio = Ratio.of(new Decimal(0.5));
      expect(ratio.toDecimal().toString()).toBe('0.5');
    });

    it('создает из дроби 1.0 (100%)', () => {
      const ratio = Ratio.of(new Decimal(1));
      expect(ratio.toDecimal().toString()).toBe('1');
    });
  });

  describe('методы доступа', () => {
    it('toDecimal() возвращает Decimal', () => {
      const ratio = Ratio.of(new Decimal(0.02));
      const decimal = ratio.toDecimal();
      expect(decimal).toBeInstanceOf(Decimal);
      expect(decimal.toString()).toBe('0.02');
    });

    it('toNumber() возвращает number', () => {
      const ratio = Ratio.of(new Decimal(0.02));
      const num = ratio.toNumber();
      expect(typeof num).toBe('number');
      expect(num).toBe(0.02);
    });

    it('onePlus() возвращает (1 + ratio)', () => {
      const markup = Ratio.of(new Decimal(0.1)); // 10%
      const onePlus = markup.onePlus();
      expect(onePlus).toBeInstanceOf(Decimal);
      expect(onePlus.toString()).toBe('1.1');
    });

    it('onePlus() для отрицательного ratio', () => {
      const discount = Ratio.of(new Decimal(-0.2)); // -20%
      const onePlus = discount.onePlus();
      expect(onePlus.toString()).toBe('0.8');
    });

    it('onePlus() для нулевого ratio', () => {
      const zero = Ratio.of(new Decimal(0));
      const onePlus = zero.onePlus();
      expect(onePlus.toString()).toBe('1');
    });
  });

  describe('сравнение', () => {
    it('equals() корректно сравнивает равные Ratio', () => {
      const r1 = Ratio.of(new Decimal(0.02));
      const r2 = Ratio.of(new Decimal(0.02));
      expect(r1.equals(r2)).toBe(true);
    });

    it('equals() корректно сравнивает разные Ratio', () => {
      const r1 = Ratio.of(new Decimal(0.02));
      const r2 = Ratio.of(new Decimal(0.03));
      expect(r1.equals(r2)).toBe(false);
    });

    it('equals() для отрицательных значений', () => {
      const r1 = Ratio.of(new Decimal(-0.1));
      const r2 = Ratio.of(new Decimal(-0.1));
      expect(r1.equals(r2)).toBe(true);
    });

    it('isZero() определяет нулевое значение', () => {
      const zero = Ratio.of(new Decimal(0));
      expect(zero.isZero()).toBe(true);

      const nonZero = Ratio.of(new Decimal(0.01));
      expect(nonZero.isZero()).toBe(false);
    });

    it('isPositive() определяет положительное значение', () => {
      const positive = Ratio.of(new Decimal(0.1));
      expect(positive.isPositive()).toBe(true);

      const zero = Ratio.of(new Decimal(0));
      expect(zero.isPositive()).toBe(false);

      const negative = Ratio.of(new Decimal(-0.1));
      expect(negative.isPositive()).toBe(false);
    });

    it('isNegative() определяет отрицательное значение', () => {
      const negative = Ratio.of(new Decimal(-0.1));
      expect(negative.isNegative()).toBe(true);

      const zero = Ratio.of(new Decimal(0));
      expect(zero.isNegative()).toBe(false);

      const positive = Ratio.of(new Decimal(0.1));
      expect(positive.isNegative()).toBe(false);
    });
  });

  describe('константы', () => {
    it('ZERO равен 0', () => {
      expect(Ratio.ZERO.toDecimal().toString()).toBe('0');
      expect(Ratio.ZERO.isZero()).toBe(true);
    });

    it('ONE равен 1', () => {
      expect(Ratio.ONE.toDecimal().toString()).toBe('1');
      expect(Ratio.ONE.toNumber()).toBe(1);
    });

    it('константы неизменяемы (singleton)', () => {
      const zero1 = Ratio.ZERO;
      const zero2 = Ratio.ZERO;
      expect(zero1).toBe(zero2); // Same reference
    });
  });
});
