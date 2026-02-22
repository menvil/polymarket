import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { ValidateDivisorForPriceDivision } from '../../../../src/price/rules/ValidateDivisorForPriceDivision';

describe('ValidateDivisorForPriceDivision', () => {
  describe('валидные делители', () => {
    it('возвращает Ok для положительного делителя', () => {
      const result = ValidateDivisorForPriceDivision.check(new Decimal(2));
      expect(result.ok).toBe(true);
    });

    it('возвращает Ok для дробного делителя', () => {
      const result = ValidateDivisorForPriceDivision.check(new Decimal(0.5));
      expect(result.ok).toBe(true);
    });
  });

  describe('NaN делитель', () => {
    it('возвращает Err для NaN', () => {
      const result = ValidateDivisorForPriceDivision.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
    });

    it('содержит reason is_nan', () => {
      const result = ValidateDivisorForPriceDivision.check(new Decimal(NaN));
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('is_nan');
      }
    });

    it('сообщение ошибки содержит NaN', () => {
      const result = ValidateDivisorForPriceDivision.check(new Decimal(NaN));
      if (!result.ok) {
        expect(result.error.message).toContain('NaN');
      }
    });
  });

  describe('не-конечный делитель', () => {
    it('возвращает Err для Infinity', () => {
      const result = ValidateDivisorForPriceDivision.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
    });

    it('возвращает Err для -Infinity', () => {
      const result = ValidateDivisorForPriceDivision.check(new Decimal(-Infinity));
      expect(result.ok).toBe(false);
    });

    it('содержит reason not_finite для Infinity', () => {
      const result = ValidateDivisorForPriceDivision.check(new Decimal(Infinity));
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('not_finite');
      }
    });

    it('сообщение ошибки содержит finite', () => {
      const result = ValidateDivisorForPriceDivision.check(new Decimal(Infinity));
      if (!result.ok) {
        expect(result.error.message).toContain('finite');
      }
    });
  });

  describe('отрицательный делитель', () => {
    it('возвращает Err для -1', () => {
      const result = ValidateDivisorForPriceDivision.check(new Decimal(-1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('is_negative');
      }
    });
  });

  describe('нулевой делитель', () => {
    it('возвращает Err для 0', () => {
      const result = ValidateDivisorForPriceDivision.check(new Decimal(0));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('is_zero');
      }
    });
  });
});
