import { describe, it, expect } from '@jest/globals';
import { divideDecimal } from '../../../src/decimal/divide.js';
import {
  DivisionByZeroError,
  ArithmeticOverflowError,
  InvalidDivisorError,
} from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('divideDecimal', () => {
  describe('нормальные операции', () => {
    it('должен делить положительные числа', () => {
      const result = divideDecimal(new Decimal(10), new Decimal(2));
      expect(result.toString()).toBe('5');
    });

    it('должен делить с остатком', () => {
      const result = divideDecimal(new Decimal(10), new Decimal(3));
      expect(result.toFixed(3)).toBe('3.333');
    });

    it('должен делить отрицательные числа', () => {
      const result = divideDecimal(new Decimal(-10), new Decimal(-2));
      expect(result.toString()).toBe('5');
    });

    it('должен разрешать деление на отрицательное (математически)', () => {
      const result = divideDecimal(new Decimal(10), new Decimal(-2));
      expect(result.toString()).toBe('-5');
    });

    it('должен делить дробные числа', () => {
      const result = divideDecimal(new Decimal(7.5), new Decimal(2.5));
      expect(result.toString()).toBe('3');
    });

    it('деление на единицу не меняет значение', () => {
      const result = divideDecimal(new Decimal(42), new Decimal(1));
      expect(result.toString()).toBe('42');
    });

    it('деление нуля на число даёт ноль', () => {
      const result = divideDecimal(new Decimal(0), new Decimal(5));
      expect(result.toString()).toBe('0');
    });

    it('должен работать с очень маленькими числами', () => {
      const result = divideDecimal(
        new Decimal('1e-10'),
        new Decimal('2e-5')
      );
      expect(result.toString()).toBe('0.000005');
    });
  });

  describe('математические свойства', () => {
    it('НЕ должен быть коммутативным (a/b ≠ b/a)', () => {
      const a = new Decimal(10);
      const b = new Decimal(2);
      expect(divideDecimal(a, b).toString()).not.toBe(
        divideDecimal(b, a).toString()
      );
    });

    it('деление на себя даёт единицу', () => {
      const a = new Decimal(42);
      const result = divideDecimal(a, a);
      expect(result.toString()).toBe('1');
    });

    it('a / b * b = a', () => {
      const a = new Decimal(10);
      const b = new Decimal(3);
      const result = divideDecimal(a, b).times(b);
      expect(result.toFixed(10)).toBe(a.toFixed(10));
    });
  });

  describe('ошибки деления на ноль', () => {
    it('должен throw DivisionByZeroError на ноль', () => {
      expect(() => divideDecimal(new Decimal(10), new Decimal(0))).toThrow(
        DivisionByZeroError
      );
    });

    it('должен throw на -0', () => {
      expect(() => divideDecimal(new Decimal(10), new Decimal(-0))).toThrow(
        DivisionByZeroError
      );
    });

    it('должен содержать контекст в ошибке', () => {
      try {
        divideDecimal(new Decimal(10), new Decimal(0));
        fail('Should throw');
      } catch (error) {
        expect(error).toBeInstanceOf(DivisionByZeroError);
        if (error instanceof DivisionByZeroError) {
          expect(error.context).toBeDefined();
          expect(error.context?.dividend).toBe('10');
          expect(error.context?.divisor).toBe('0');
        }
      }
    });
  });

  describe('ошибки невалидного делителя', () => {
    it('должен throw InvalidDivisorError на NaN', () => {
      expect(() => divideDecimal(new Decimal(10), new Decimal(NaN))).toThrow(
        InvalidDivisorError
      );
    });

    it('должен throw InvalidDivisorError на Infinity', () => {
      expect(() =>
        divideDecimal(new Decimal(10), new Decimal(Infinity))
      ).toThrow(InvalidDivisorError);
    });

    it('должен throw InvalidDivisorError на -Infinity', () => {
      expect(() =>
        divideDecimal(new Decimal(10), new Decimal(-Infinity))
      ).toThrow(InvalidDivisorError);
    });

    it('должен содержать контекст в ошибке', () => {
      try {
        divideDecimal(new Decimal(10), new Decimal(NaN));
        fail('Should throw');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidDivisorError);
        if (error instanceof InvalidDivisorError) {
          expect(error.context).toBeDefined();
          expect(error.context?.dividend).toBe('10');
          expect(error.context?.divisor).toBe('NaN');
        }
      }
    });
  });

  describe('ошибки overflow', () => {
    it('должен throw ArithmeticOverflowError на overflow (Infinity dividend)', () => {
      const inf = new Decimal(Infinity);
      const value = new Decimal(2);
      expect(() => divideDecimal(inf, value)).toThrow(
        ArithmeticOverflowError
      );
    });

    it('должен содержать контекст в ошибке overflow', () => {
      const inf = new Decimal(Infinity);
      const value = new Decimal(2);
      try {
        divideDecimal(inf, value);
        fail('Should throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ArithmeticOverflowError);
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.dividend).toBe('Infinity');
          expect(error.context?.divisor).toBe('2');
          expect(error.context?.result).toBe('Infinity');
        }
      }
    });
  });

  describe('точность', () => {
    it('должен сохранять точность при делении дробных', () => {
      const result = divideDecimal(new Decimal('1'), new Decimal('3'));
      expect(result.toFixed(10)).toBe('0.3333333333');
    });

    it('должен корректно работать с большой точностью', () => {
      const result = divideDecimal(new Decimal('10'), new Decimal('3'));
      // Проверяем что результат правильный (периодическая дробь 3.333...)
      expect(result.toFixed(15)).toBe('3.333333333333333');
      expect(result.times(3).toFixed(10)).toBe('10.0000000000');
    });
  });
});
