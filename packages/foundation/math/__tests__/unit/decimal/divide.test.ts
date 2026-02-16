import { describe, it, expect } from '@jest/globals';
import { divideDecimal } from '../../../src/decimal/divide.js';
import {
  DivisionByZeroError,
  InvalidDivisorError,
  InvalidOperandError,
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
      expect(() => divideDecimal(new Decimal(10), new Decimal(0))).toThrow(
        DivisionByZeroError
      );

      try {
        divideDecimal(new Decimal(10), new Decimal(0));
        fail('Expected DivisionByZeroError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DivisionByZeroError);
        if (error instanceof DivisionByZeroError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBe('10');
          expect(error.context?.b).toBe('0');
        }
      }
    });

    it('должен проверять валидность a перед проверкой на ноль (порядок проверок)', () => {
      // Контракт: InvalidOperandError имеет приоритет над DivisionByZeroError
      // Даже если b = 0, сначала проверяется валидность a
      expect(() =>
        divideDecimal(new Decimal(NaN), new Decimal(0))
      ).toThrow(InvalidOperandError);

      expect(() =>
        divideDecimal(new Decimal(Infinity), new Decimal(0))
      ).toThrow(InvalidOperandError);

      expect(() =>
        divideDecimal(new Decimal(-Infinity), new Decimal(0))
      ).toThrow(InvalidOperandError);
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
      expect(() => divideDecimal(new Decimal(10), new Decimal(NaN))).toThrow(
        InvalidDivisorError
      );

      try {
        divideDecimal(new Decimal(10), new Decimal(NaN));
        expect(true).toBe(false); // Expected InvalidDivisorError to be thrown
      } catch (error) {
        if (error instanceof InvalidDivisorError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBe('10');
          expect(error.context?.b).toBe('NaN');
        } else {
          throw error;
        }
      }
    });
  });

  describe('ошибки invalid operand (a)', () => {
    it('должен throw InvalidOperandError на Infinity a', () => {
      const inf = new Decimal(Infinity);
      const value = new Decimal(2);
      expect(() => divideDecimal(inf, value)).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на -Infinity a', () => {
      const negInf = new Decimal(-Infinity);
      const value = new Decimal(2);
      expect(() => divideDecimal(negInf, value)).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на NaN a', () => {
      const nan = new Decimal(NaN);
      const value = new Decimal(2);
      expect(() => divideDecimal(nan, value)).toThrow(InvalidOperandError);
    });

    it('должен содержать контекст в ошибке invalid a', () => {
      const inf = new Decimal(Infinity);
      const value = new Decimal(2);

      expect(() => divideDecimal(inf, value)).toThrow(InvalidOperandError);

      try {
        divideDecimal(inf, value);
        expect(true).toBe(false); // Expected InvalidOperandError to be thrown
      } catch (error) {
        if (error instanceof InvalidOperandError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBe('Infinity');
          expect(error.context?.b).toBe('2');
          expect(error.context?.operation).toBe('divide');
        } else {
          throw error;
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
