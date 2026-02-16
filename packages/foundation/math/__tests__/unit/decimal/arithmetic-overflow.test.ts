import { describe, it, expect } from '@jest/globals';
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  averageDecimal,
} from '../../../src/decimal/index.js';
import { ArithmeticOverflowError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Тесты для проверки ArithmeticOverflowError в арифметических операциях.
 *
 * Эти тесты покрывают критические ветки overflow, которые возникают
 * при выходе результата операции за пределы конечных чисел.
 *
 * @remarks
 * Используем граничные значения Decimal.js:
 * - MAX_SAFE = 1e308 (близко к Number.MAX_VALUE)
 * - TINY = 1e-308 (близко к Number.MIN_VALUE)
 */
describe('Arithmetic Overflow Tests', () => {
  // Константы для тестов
  const MAX_SAFE = new Decimal('1e308');
  const TINY = new Decimal('1e-308');

  describe('addDecimal overflow', () => {
    /**
     * Тест проверяет, что addDecimal бросает ArithmeticOverflowError
     * при сложении двух огромных чисел, когда результат = Infinity.
     */
    it('должен throw ArithmeticOverflowError при переполнении', () => {
      const huge1 = new Decimal('9e307');
      const huge2 = new Decimal('9e307');

      expect(() => addDecimal(huge1, huge2)).toThrow(ArithmeticOverflowError);
    });

    /**
     * Тест проверяет, что ошибка overflow содержит полный контекст операции.
     */
    it('должен содержать контекст в ошибке overflow', () => {
      const huge1 = new Decimal('9e307');
      const huge2 = new Decimal('9e307');

      try {
        addDecimal(huge1, huge2);
        // Если не бросило ошибку - тест провален
        expect(true).toBe(false);
      } catch (error) {
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.operation).toBe('add');
          expect(error.context?.a).toBeDefined();
          expect(error.context?.b).toBeDefined();
        } else {
          throw error;
        }
      }
    });
  });

  describe('subtractDecimal overflow', () => {
    /**
     * Тест проверяет overflow при вычитании огромного отрицательного числа
     * из огромного положительного (эквивалентно сложению двух огромных чисел).
     */
    it('должен throw ArithmeticOverflowError при переполнении', () => {
      const huge = new Decimal('9e307');
      const negHuge = new Decimal('-9e307');

      expect(() => subtractDecimal(huge, negHuge)).toThrow(ArithmeticOverflowError);
    });

    /**
     * Тест проверяет контекст ошибки для subtractDecimal.
     */
    it('должен содержать контекст в ошибке overflow', () => {
      const huge = new Decimal('9e307');
      const negHuge = new Decimal('-9e307');

      try {
        subtractDecimal(huge, negHuge);
        expect(true).toBe(false);
      } catch (error) {
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.operation).toBe('subtract');
        } else {
          throw error;
        }
      }
    });
  });

  describe('multiplyDecimal overflow', () => {
    /**
     * Тест проверяет overflow при умножении двух огромных чисел.
     * 1e200 * 1e200 = 1e400 > 1e308 (максимальное значение).
     */
    it('должен throw ArithmeticOverflowError при переполнении', () => {
      const huge = new Decimal('1e200');

      expect(() => multiplyDecimal(huge, huge)).toThrow(ArithmeticOverflowError);
    });

    /**
     * Тест проверяет контекст ошибки для multiplyDecimal.
     */
    it('должен содержать контекст в ошибке overflow', () => {
      const huge = new Decimal('1e200');

      try {
        multiplyDecimal(huge, huge);
        expect(true).toBe(false);
      } catch (error) {
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.operation).toBe('multiply');
          expect(error.context?.a).toBeDefined();
          expect(error.context?.b).toBeDefined();
        } else {
          throw error;
        }
      }
    });
  });

  describe('divideDecimal overflow', () => {
    /**
     * Тест проверяет overflow при делении огромного числа на крошечное.
     * 1e308 / 1e-308 = 1e616 > 1e308 (overflow).
     */
    it('должен throw ArithmeticOverflowError при переполнении', () => {
      expect(() => divideDecimal(MAX_SAFE, TINY)).toThrow(ArithmeticOverflowError);
    });

    /**
     * Тест проверяет, что контекст содержит dividend, divisor и result.
     */
    it('должен содержать контекст в ошибке overflow', () => {
      try {
        divideDecimal(MAX_SAFE, TINY);
        expect(true).toBe(false);
      } catch (error) {
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.dividend).toBeDefined();
          expect(error.context?.divisor).toBeDefined();
          expect(error.context?.result).toBe('Infinity');
        } else {
          throw error;
        }
      }
    });
  });

  describe('averageDecimal overflow', () => {
    /**
     * Тест проверяет overflow при вычислении среднего двух огромных чисел.
     * average(9e307, 9e307) = (9e307 + 9e307) / 2 = overflow при сложении.
     */
    it('должен throw ArithmeticOverflowError при переполнении', () => {
      const huge = new Decimal('9e307');

      expect(() => averageDecimal(huge, huge)).toThrow(ArithmeticOverflowError);
    });

    /**
     * Тест проверяет контекст ошибки для averageDecimal.
     */
    it('должен содержать контекст в ошибке overflow', () => {
      const huge = new Decimal('9e307');

      try {
        averageDecimal(huge, huge);
        expect(true).toBe(false);
      } catch (error) {
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.operation).toBeDefined();
        } else {
          throw error;
        }
      }
    });
  });
});
