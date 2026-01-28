import { describe, it, expect } from '@jest/globals';
import { addDecimal } from '../../../src/decimal/add.js';
import { ArithmeticOverflowError } from '@polymarket/errors';
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
      expect(result.toNumber()).toBeCloseTo(3.8, 10);
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

  describe('математические свойства', () => {
    it('должен быть коммутативным (a+b = b+a)', () => {
      const a = new Decimal(5);
      const b = new Decimal(3);
      expect(addDecimal(a, b).toString()).toBe(addDecimal(b, a).toString());
    });

    it('должен быть ассоциативным ((a+b)+c = a+(b+c))', () => {
      const a = new Decimal(5);
      const b = new Decimal(3);
      const c = new Decimal(2);

      const left = addDecimal(addDecimal(a, b), c);
      const right = addDecimal(a, addDecimal(b, c));

      expect(left.toString()).toBe(right.toString());
    });

    it('ноль должен быть нейтральным элементом', () => {
      const a = new Decimal(42);
      const zero = new Decimal(0);
      expect(addDecimal(a, zero).toString()).toBe(a.toString());
    });
  });

  describe('граничные случаи', () => {
    it('должен throw на overflow (положительный Infinity)', () => {
      const inf = new Decimal(Infinity);
      const value = new Decimal(100);
      expect(() => addDecimal(inf, value)).toThrow(ArithmeticOverflowError);
    });

    it('должен throw на overflow (отрицательный Infinity)', () => {
      const negInf = new Decimal(-Infinity);
      const value = new Decimal(100);
      expect(() => addDecimal(negInf, value)).toThrow(ArithmeticOverflowError);
    });

    it('должен содержать контекст в ошибке overflow', () => {
      const inf = new Decimal(Infinity);
      const value = new Decimal(100);
      try {
        addDecimal(inf, value);
        fail('Should throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ArithmeticOverflowError);
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBe('Infinity');
          expect(error.context?.b).toBe('100');
          expect(error.context?.result).toBe('Infinity');
        }
      }
    });
  });

  describe('точность', () => {
    it('должен сохранять точность при сложении дробных', () => {
      const result = addDecimal(new Decimal('0.1'), new Decimal('0.2'));
      expect(result.toString()).toBe('0.3'); // Не 0.30000000000000004!
    });

    it('должен корректно работать с разными знаками после запятой', () => {
      const result = addDecimal(new Decimal('1.123456789'), new Decimal('2.987654321'));
      expect(result.toString()).toBe('4.11111111');
    });
  });
});
