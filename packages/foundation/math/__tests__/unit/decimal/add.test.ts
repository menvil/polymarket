import { describe, it, expect } from '@jest/globals';
import { addDecimal } from '../../../src/decimal/add.js';
import { InvalidOperandError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('addDecimal', () => {
  describe('нормальные операции', () => {
    it('должен складывать положительные числа', () => {
      const result = addDecimal(new Decimal(5), new Decimal(3));
      expect(result.toString()).toBe('8');
    });

    it('должен складывать отрицательные числа', () => {
      const result = addDecimal(new Decimal(-5), new Decimal(-3));
      expect(result.toString()).toBe('-8');
    });

    it('должен складывать положительное и отрицательное', () => {
      const result = addDecimal(new Decimal(10), new Decimal(-3));
      expect(result.toString()).toBe('7');
    });

    it('должен складывать дробные числа', () => {
      const result = addDecimal(new Decimal(1.5), new Decimal(2.3));
      expect(result.toString()).toBe('3.8');
    });

    it('должен работать с нулём', () => {
      const result = addDecimal(new Decimal(5), new Decimal(0));
      expect(result.toString()).toBe('5');
    });

    it('должен работать с очень маленькими числами', () => {
      const result = addDecimal(new Decimal('1e-10'), new Decimal('2e-10'));
      expect(result.toString()).toBe('3e-10');
    });

    it('должен работать с очень большими числами', () => {
      const result = addDecimal(new Decimal('1e100'), new Decimal('2e100'));
      expect(result.toString()).toBe('3e+100');
    });
  });

  describe('проверка валидации операндов', () => {
    it.each([
      ['Infinity', Infinity, 100],
      ['-Infinity', -Infinity, 100],
      ['NaN', NaN, 100],
      ['100', 100, Infinity],
      ['100', 100, -Infinity],
      ['100', 100, NaN],
    ])(
      'должен throw InvalidOperandError на невалидные операнды: a=%s b=%s',
      (_label, a, b) => {
        expect(() => addDecimal(new Decimal(a), new Decimal(b))).toThrow(
          InvalidOperandError
        );
      }
    );

    it('должен содержать контекст в InvalidOperandError', () => {
      const inf = new Decimal(Infinity);
      const value = new Decimal(100);
      try {
        addDecimal(inf, value);
        fail('Should throw');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidOperandError);
        if (error instanceof InvalidOperandError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBe('Infinity');
          expect(error.context?.b).toBe('100');
          expect(error.context?.operation).toBe('add');
        }
      }
    });
  });

  describe('точность', () => {
    it('должен корректно складывать 0.1 + 0.2', () => {
      const result = addDecimal(new Decimal(0.1), new Decimal(0.2));
      expect(result.toString()).toBe('0.3'); // Не 0.30000000000000004!
    });

    it('должен сохранять точность для больших дробных чисел', () => {
      const result = addDecimal(
        new Decimal('1.123456789123456789'),
        new Decimal('2.987654321987654321')
      );
      expect(result.toString()).toBe('4.11111111111111111');
    });
  });
});
