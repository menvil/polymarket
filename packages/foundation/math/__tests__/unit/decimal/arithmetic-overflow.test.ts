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
 * Decimal.js имеет maxE = 9e15 и minE = -9e15.
 * Для overflow нужны операции, результат которых превышает эти границы.
 *
 * Стратегия:
 * - Для сложения/вычитания: 5e+maxE (при сложении даст 1e+(maxE+1) = overflow)
 * - Для умножения: 1e+(maxE/2+1) (при умножении даст 1e+(maxE+2) = overflow)
 */
describe('Arithmetic Overflow Tests', () => {
  // Для overflow при сложении: 5e+maxE + 5e+maxE = 1e+(maxE+1) = Infinity
  const NEAR_MAX_FOR_ADD = new Decimal('5e' + Decimal.maxE);

  // Для overflow при умножении: sqrt(maxE) * sqrt(maxE) = overflow
  const SQRT_MAX_E = new Decimal('1e' + (Math.floor(Decimal.maxE / 2) + 1));

  // Для overflow при делении
  const NEAR_MAX_E = new Decimal('5e' + (Decimal.maxE - 1000));
  const TINY = new Decimal('1e-1500');

  describe('addDecimal overflow', () => {
    /**
     * Тест проверяет, что addDecimal бросает ArithmeticOverflowError
     * при сложении двух огромных чисел, когда результат превышает maxE.
     */
    it('должен throw ArithmeticOverflowError при переполнении', () => {
      expect(() => addDecimal(NEAR_MAX_FOR_ADD, NEAR_MAX_FOR_ADD)).toThrow(
        ArithmeticOverflowError
      );
    });

    /**
     * Тест проверяет, что ошибка overflow содержит полный контекст операции.
     */
    it('должен содержать контекст в ошибке overflow', () => {
      try {
        addDecimal(NEAR_MAX_FOR_ADD, NEAR_MAX_FOR_ADD);
        // Если не бросило ошибку - тест провален
        fail('Expected ArithmeticOverflowError to be thrown');
      } catch (error) {
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBeDefined();
          expect(error.context?.b).toBeDefined();
          expect(error.context?.result).toBe('Infinity');
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
      const negHuge = NEAR_MAX_FOR_ADD.neg();

      expect(() => subtractDecimal(NEAR_MAX_FOR_ADD, negHuge)).toThrow(
        ArithmeticOverflowError
      );
    });

    /**
     * Тест проверяет контекст ошибки для subtractDecimal.
     */
    it('должен содержать контекст в ошибке overflow', () => {
      const negHuge = NEAR_MAX_FOR_ADD.neg();

      try {
        subtractDecimal(NEAR_MAX_FOR_ADD, negHuge);
        expect(true).toBe(false);
      } catch (error) {
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBeDefined();
          expect(error.context?.b).toBeDefined();
          expect(error.context?.result).toBe('Infinity');
        } else {
          throw error;
        }
      }
    });
  });

  describe('multiplyDecimal overflow', () => {
    /**
     * Тест проверяет overflow при умножении двух огромных чисел.
     * Используем числа, которые при умножении превысят maxE.
     */
    it('должен throw ArithmeticOverflowError при переполнении', () => {
      expect(() => multiplyDecimal(SQRT_MAX_E, SQRT_MAX_E)).toThrow(
        ArithmeticOverflowError
      );
    });

    /**
     * Тест проверяет контекст ошибки для multiplyDecimal.
     */
    it('должен содержать контекст в ошибке overflow', () => {
      try {
        multiplyDecimal(SQRT_MAX_E, SQRT_MAX_E);
        expect(true).toBe(false);
      } catch (error) {
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBeDefined();
          expect(error.context?.b).toBeDefined();
          expect(error.context?.result).toBe('Infinity');
        } else {
          throw error;
        }
      }
    });
  });

  describe('divideDecimal overflow', () => {
    /**
     * Тест проверяет overflow при делении огромного числа на крошечное.
     * Используем числа, при делении которых результат превысит maxE.
     */
    it('должен throw ArithmeticOverflowError при переполнении', () => {
      expect(() => divideDecimal(NEAR_MAX_E, TINY)).toThrow(
        ArithmeticOverflowError
      );
    });

    /**
     * Тест проверяет, что контекст содержит a, b и result.
     */
    it('должен содержать контекст в ошибке overflow', () => {
      try {
        divideDecimal(NEAR_MAX_E, TINY);
        expect(true).toBe(false);
      } catch (error) {
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.a).toBeDefined();
          expect(error.context?.b).toBeDefined();
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
     * average = (a + b) / 2, overflow происходит при сложении.
     */
    it('должен throw ArithmeticOverflowError при переполнении', () => {
      expect(() => averageDecimal(NEAR_MAX_FOR_ADD, NEAR_MAX_FOR_ADD)).toThrow(
        ArithmeticOverflowError
      );
    });

    /**
     * Тест проверяет контекст ошибки для averageDecimal.
     */
    it('должен содержать контекст в ошибке overflow', () => {
      try {
        averageDecimal(NEAR_MAX_FOR_ADD, NEAR_MAX_FOR_ADD);
        expect(true).toBe(false);
      } catch (error) {
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.operation).toBe('average');
          expect(error.context?.a).toBeDefined();
          expect(error.context?.b).toBeDefined();
          expect(error.context?.result).toBe('Infinity');
        } else {
          throw error;
        }
      }
    });
  });
});
