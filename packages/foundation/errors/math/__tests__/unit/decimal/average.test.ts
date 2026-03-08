import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { averageDecimal } from '../../../src/decimal/average.js';
import { InvalidOperandError } from '@polymarket/errors';

describe('averageDecimal', () => {
  describe('Успешные случаи', () => {
    it('должен вычислять среднее двух положительных целых чисел', () => {
      const result = averageDecimal(new Decimal(10), new Decimal(20));
      expect(result.toString()).toBe('15');
    });

    it('должен вычислять среднее двух десятичных чисел', () => {
      const result = averageDecimal(new Decimal(0.5), new Decimal(0.7));
      expect(result.toString()).toBe('0.6');
    });

    it('должен обрабатывать одинаковые значения', () => {
      const result = averageDecimal(new Decimal(5), new Decimal(5));
      expect(result.toString()).toBe('5');
    });

    it('должен обрабатывать ноль и положительное число', () => {
      const result = averageDecimal(new Decimal(0), new Decimal(10));
      expect(result.toString()).toBe('5');
    });

    it('должен обрабатывать отрицательное и положительное (результат ноль)', () => {
      const result = averageDecimal(new Decimal(-10), new Decimal(10));
      expect(result.toString()).toBe('0');
    });

    it('должен обрабатывать два отрицательных числа', () => {
      const result = averageDecimal(new Decimal(-10), new Decimal(-20));
      expect(result.toString()).toBe('-15');
    });

    it('должен обрабатывать очень маленькие числа', () => {
      const result = averageDecimal(new Decimal(0.0001), new Decimal(0.0003));
      expect(result.toString()).toBe('0.0002');
    });

    it('должен обрабатывать большие числа в допустимом диапазоне', () => {
      const result = averageDecimal(new Decimal(1e6), new Decimal(2e6));
      expect(result.toString()).toBe('1500000');
    });

    it('должен сохранять точность', () => {
      const result = averageDecimal(
        new Decimal('0.123456789'),
        new Decimal('0.987654321')
      );
      expect(result.toString()).toBe('0.555555555');
    });
  });

  describe('Валидация входных данных', () => {
    it.each([
      ['Infinity', Infinity, 10],
      ['-Infinity', -Infinity, 10],
      ['NaN', NaN, 10],
      ['10', 10, Infinity],
      ['10', 10, -Infinity],
      ['10', 10, NaN],
    ])(
      'должен throw InvalidOperandError на невалидные операнды: a=%s b=%s',
      (_label, a, b) => {
        expect(() => averageDecimal(new Decimal(a), new Decimal(b))).toThrow(
          InvalidOperandError
        );
      }
    );
  });

  describe('Контекст ошибки', () => {
    it('должен включать детали операции в InvalidOperandError', () => {
      expect.assertions(5);
      const inf = new Decimal(Infinity);

      expect(() => averageDecimal(inf, new Decimal(10))).toThrow(
        InvalidOperandError
      );

      try {
        averageDecimal(inf, new Decimal(10));
      } catch (error) {
        if (error instanceof InvalidOperandError) {
          expect(error.context).toBeDefined();
          expect(error.context?.operation).toBe('average');
          expect(error.context?.a).toBe('Infinity');
          expect(error.context?.b).toBe('10');
        }
      }
    });
  });
});
