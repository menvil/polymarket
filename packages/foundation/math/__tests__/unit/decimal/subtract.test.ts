import { describe, it, expect } from '@jest/globals';
import { subtractDecimal } from '../../../src/decimal/subtract.js';
import { InvalidOperandError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('subtractDecimal', () => {
  describe('нормальные операции', () => {
    it('должен вычитать положительные числа', () => {
      const result = subtractDecimal(new Decimal(10), new Decimal(3));
      expect(result.toString()).toBe('7');
    });

    it('должен вычитать отрицательные числа', () => {
      const result = subtractDecimal(new Decimal(-5), new Decimal(-3));
      expect(result.toString()).toBe('-2');
    });

    it('должен разрешать отрицательный результат', () => {
      const result = subtractDecimal(new Decimal(3), new Decimal(10));
      expect(result.toString()).toBe('-7');
    });

    it('должен вычитать дробные числа', () => {
      const result = subtractDecimal(new Decimal(5.5), new Decimal(2.3));
      expect(result.toString()).toBe('3.2');
    });

    it('должен работать с нулём', () => {
      const result = subtractDecimal(new Decimal(5), new Decimal(0));
      expect(result.toString()).toBe('5');
    });

    it('результат вычитания самого из себя = 0', () => {
      const a = new Decimal(42);
      const result = subtractDecimal(a, a);
      expect(result.toString()).toBe('0');
    });

    it('должен работать с очень маленькими числами', () => {
      const result = subtractDecimal(new Decimal('3e-10'), new Decimal('1e-10'));
      expect(result.toString()).toBe('2e-10');
    });
  });

  describe('проверка валидации операндов', () => {
    it('должен throw InvalidOperandError на Infinity в первом операнде', () => {
      const inf = new Decimal(Infinity);
      const value = new Decimal(100);
      expect(() => subtractDecimal(inf, value)).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на -Infinity в первом операнде', () => {
      const negInf = new Decimal(-Infinity);
      const value = new Decimal(100);
      expect(() => subtractDecimal(negInf, value)).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на NaN в первом операнде', () => {
      const nan = new Decimal(NaN);
      const value = new Decimal(100);
      expect(() => subtractDecimal(nan, value)).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на Infinity во втором операнде', () => {
      const value = new Decimal(100);
      const inf = new Decimal(Infinity);
      expect(() => subtractDecimal(value, inf)).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на NaN во втором операнде', () => {
      const value = new Decimal(100);
      const nan = new Decimal(NaN);
      expect(() => subtractDecimal(value, nan)).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на -Infinity во втором операнде', () => {
      const value = new Decimal(100);
      const negInf = new Decimal(-Infinity);
      expect(() => subtractDecimal(value, negInf)).toThrow(InvalidOperandError);
    });

    it('должен содержать контекст в InvalidOperandError', () => {
      const inf = new Decimal(Infinity);
      const value = new Decimal(100);

      expect(() => subtractDecimal(inf, value)).toThrow(InvalidOperandError);

      try {
        subtractDecimal(inf, value);
      } catch (error) {
        if (error instanceof InvalidOperandError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBe('Infinity');
          expect(error.context?.b).toBe('100');
          expect(error.context?.operation).toBe('subtract');
        }
      }
    });
  });

  describe('точность', () => {
    it('должен сохранять точность при вычитании дробных', () => {
      const result = subtractDecimal(new Decimal('0.3'), new Decimal('0.1'));
      expect(result.toString()).toBe('0.2'); // Не 0.19999999999999998!
    });

    it('должен корректно работать с разными знаками после запятой', () => {
      const result = subtractDecimal(new Decimal('5.123456789'), new Decimal('2.987654321'));
      expect(result.toString()).toBe('2.135802468');
    });
  });
});
