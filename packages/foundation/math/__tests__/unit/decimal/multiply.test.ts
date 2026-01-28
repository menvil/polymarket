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

  // ==================== MATHEMATICAL PROPERTIES ====================
  describe('Математические свойства', () => {
    it('должен соблюдать коммутативность (a * b = b * a)', () => {
      const a = new Decimal('5.5');
      const b = new Decimal('3.2');

      const result1 = multiplyDecimal(a, b);
      const result2 = multiplyDecimal(b, a);

      expect(result1.equals(result2)).toBe(true);
    });

    it('должен соблюдать ассоциативность ((a * b) * c = a * (b * c))', () => {
      const a = new Decimal('2');
      const b = new Decimal('3');
      const c = new Decimal('4');

      const result1 = multiplyDecimal(multiplyDecimal(a, b), c);
      const result2 = multiplyDecimal(a, multiplyDecimal(b, c));

      expect(result1.equals(result2)).toBe(true);
    });

    it('должен соблюдать свойство нейтрального элемента (a * 1 = a)', () => {
      const a = new Decimal('42.5');
      const result = multiplyDecimal(a, MATH_CONSTANTS.ONE);

      expect(result.equals(a)).toBe(true);
    });

    it('должен соблюдать свойство нуля (a * 0 = 0)', () => {
      const a = new Decimal('123.456');
      const result = multiplyDecimal(a, MATH_CONSTANTS.ZERO);

      expect(result.equals(MATH_CONSTANTS.ZERO)).toBe(true);
    });

    it('должен соблюдать дистрибутивность (a * (b + c) = a * b + a * c)', () => {
      const a = new Decimal('2');
      const b = new Decimal('3');
      const c = new Decimal('4');

      const left = multiplyDecimal(a, b.plus(c));
      const right = multiplyDecimal(a, b).plus(multiplyDecimal(a, c));

      expect(left.equals(right)).toBe(true);
    });
  });

  // ==================== INPUT VALIDATION ====================
  describe('Проверка валидации операндов', () => {
    it('должен throw InvalidOperandError на Infinity в первом операнде', () => {
      const inf = new Decimal(Infinity);
      const value = new Decimal(100);

      expect(() => multiplyDecimal(inf, value)).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на -Infinity в первом операнде', () => {
      const negInf = new Decimal(-Infinity);
      const value = new Decimal(100);

      expect(() => multiplyDecimal(negInf, value)).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на NaN в первом операнде', () => {
      const nan = new Decimal(NaN);
      const value = new Decimal(100);

      expect(() => multiplyDecimal(nan, value)).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на Infinity во втором операнде', () => {
      const value = new Decimal(100);
      const inf = new Decimal(Infinity);

      expect(() => multiplyDecimal(value, inf)).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на NaN во втором операнде', () => {
      const value = new Decimal(100);
      const nan = new Decimal(NaN);

      expect(() => multiplyDecimal(value, nan)).toThrow(InvalidOperandError);
    });

    it('должен содержать контекст в InvalidOperandError', () => {
      const inf = new Decimal(Infinity);
      const value = new Decimal(100);

      try {
        multiplyDecimal(inf, value);
        fail('Should have thrown InvalidOperandError');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidOperandError);
        if (error instanceof InvalidOperandError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBe('Infinity');
          expect(error.context?.b).toBe('100');
          expect(error.context?.operation).toBe('multiply');
        }
      }
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
