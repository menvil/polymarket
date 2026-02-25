/**
 * Тесты для Liquidity value object
 */

import { isValidLiquidity, ALL_LIQUIDITY } from '../../../src/value-objects/Liquidity';

describe('Liquidity', () => {
  describe('isValidLiquidity()', () => {
    it('возвращает true для MAKER', () => {
      expect(isValidLiquidity('MAKER')).toBe(true);
    });

    it('возвращает true для TAKER', () => {
      expect(isValidLiquidity('TAKER')).toBe(true);
    });

    it('возвращает false для пустой строки', () => {
      expect(isValidLiquidity('')).toBe(false);
    });

    it('возвращает false для null', () => {
      expect(isValidLiquidity(null)).toBe(false);
    });

    it('возвращает false для undefined', () => {
      expect(isValidLiquidity(undefined)).toBe(false);
    });

    it('возвращает false для числа', () => {
      expect(isValidLiquidity(123)).toBe(false);
    });

    it('возвращает false для другой строки', () => {
      expect(isValidLiquidity('UNKNOWN')).toBe(false);
      expect(isValidLiquidity('maker')).toBe(false);
      expect(isValidLiquidity('taker')).toBe(false);
    });
  });

  describe('ALL_LIQUIDITY', () => {
    it('содержит все допустимые значения', () => {
      expect(ALL_LIQUIDITY).toContain('MAKER');
      expect(ALL_LIQUIDITY).toContain('TAKER');
      expect(ALL_LIQUIDITY).toHaveLength(2);
    });

    it('является readonly массивом', () => {
      expect(Object.isFrozen(ALL_LIQUIDITY)).toBe(true);
    });
  });
});
