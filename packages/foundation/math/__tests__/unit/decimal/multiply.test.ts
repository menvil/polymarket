import Decimal from 'decimal.js';
import { multiplyDecimal } from '../../../src/decimal/multiply.js';
import { MATH_CONSTANTS } from '../../../src/constants.js';
import { InvalidOperandError } from '@polymarket/errors';

describe('multiplyDecimal', () => {
  // ==================== NORMAL OPERATIONS ====================
  describe('Нормальные операции', () => {
    it('должен умножать положительные числа', () => {
      const result = multiplyDecimal(new Decimal(5), new Decimal(3));
      expect(result.toString()).toBe('15');
    });

    it('должен умножать отрицательные числа', () => {
      const result = multiplyDecimal(new Decimal(-5), new Decimal(-3));
      expect(result.toString()).toBe('15');
    });

    it('должен умножать положительное и отрицательное число', () => {
      const result = multiplyDecimal(new Decimal(5), new Decimal(-3));
      expect(result.toString()).toBe('-15');
    });

    it('должен умножать десятичные числа', () => {
      const result = multiplyDecimal(new Decimal('2.5'), new Decimal('4'));
      expect(result.toString()).toBe('10');
    });

    it('должен умножать очень маленькие числа', () => {
      const result = multiplyDecimal(new Decimal('0.0001'), new Decimal('0.01'));
      expect(result.toString()).toBe('0.000001');
    });

    it('должен умножать очень большие числа', () => {
      const result = multiplyDecimal(new Decimal('1e50'), new Decimal('2e50'));
      expect(result.toString()).toBe('2e+100');
    });

    it('должен умножать на ноль', () => {
      const result = multiplyDecimal(new Decimal(42), MATH_CONSTANTS.ZERO);
      expect(result.toString()).toBe('0');
    });
  });

  // ==================== INPUT VALIDATION ====================
  describe('Проверка валидации операндов', () => {
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
        expect(() => multiplyDecimal(new Decimal(a), new Decimal(b))).toThrow(
          InvalidOperandError
        );
      }
    );

    it('должен содержать контекст в InvalidOperandError', () => {
      expect.assertions(5);
      const inf = new Decimal(Infinity);
      const value = new Decimal(100);

      expect(() => multiplyDecimal(inf, value)).toThrow(
        InvalidOperandError
      );

      try {
        multiplyDecimal(inf, value);
      } catch (error) {
        if (error instanceof InvalidOperandError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBe('Infinity');
          expect(error.context?.b).toBe('100');
          expect(error.context?.operation).toBe('multiply');
        }
      }
    });
  });

  // ==================== MATHEMATICAL PROPERTIES ====================
  describe('Математические свойства', () => {
    it('должен быть коммутативным: multiplyDecimal(a,b) === multiplyDecimal(b,a)', () => {
      const testCases = [
        [new Decimal('5'), new Decimal('3')],
        [new Decimal('0.123'), new Decimal('456.789')],
        [new Decimal('-2.5'), new Decimal('4.8')],
      ];

      testCases.forEach(([a, b]) => {
        const resultAB = multiplyDecimal(a, b);
        const resultBA = multiplyDecimal(b, a);
        expect(resultAB.equals(resultBA)).toBe(true);
      });
    });
  });

  // ==================== PRECISION TESTS ====================
  describe('Тесты точности', () => {
    it('должен корректно работать с высокой точностью (0.1 * 0.2)', () => {
      const result = multiplyDecimal(new Decimal('0.1'), new Decimal('0.2'));

      // В обычном JS: 0.1 * 0.2 = 0.020000000000000004 ❌
      // С Decimal.js: точно 0.02 ✅
      expect(result.toString()).toBe('0.02');
    });

    it('должен корректно работать с ценами (0.6543 * 100)', () => {
      const price = new Decimal('0.6543');
      const quantity = new Decimal('100');

      const result = multiplyDecimal(price, quantity);

      expect(result.toString()).toBe('65.43');
    });
  });

});
