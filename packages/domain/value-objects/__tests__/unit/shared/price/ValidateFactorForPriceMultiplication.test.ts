import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { ValidateFactorForPriceMultiplication } from '../../../../src/shared/price/ValidateFactorForPriceMultiplication.js';

describe('ValidateFactorForPriceMultiplication', () => {
  describe('валидные множители', () => {
    it('возвращает Ok для положительного множителя', () => {
      const result = ValidateFactorForPriceMultiplication.check(new Decimal(2));
      expect(result.ok).toBe(true);
    });

    it('возвращает Ok для дробного множителя', () => {
      const result = ValidateFactorForPriceMultiplication.check(new Decimal(0.5));
      expect(result.ok).toBe(true);
    });

    it('возвращает Ok для нулевого множителя', () => {
      const result = ValidateFactorForPriceMultiplication.check(new Decimal(0));
      expect(result.ok).toBe(true);
    });
  });

  describe('NaN множитель', () => {
    it('возвращает Err для NaN', () => {
      const result = ValidateFactorForPriceMultiplication.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
    });

    it('содержит reason is_nan', () => {
      const result = ValidateFactorForPriceMultiplication.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('is_nan');
      }
    });

    it('сообщение ошибки содержит NaN', () => {
      const result = ValidateFactorForPriceMultiplication.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('NaN');
      }
    });
  });

  describe('не-конечный множитель', () => {
    it('возвращает Err для Infinity', () => {
      const result = ValidateFactorForPriceMultiplication.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
    });

    it('возвращает Err для -Infinity (not_finite, не is_negative)', () => {
      const result = ValidateFactorForPriceMultiplication.check(new Decimal(-Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('not_finite');
      }
    });

    it('содержит reason not_finite для Infinity', () => {
      const result = ValidateFactorForPriceMultiplication.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('not_finite');
      }
    });

    it('сообщение ошибки содержит finite', () => {
      const result = ValidateFactorForPriceMultiplication.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('finite');
      }
    });
  });

  describe('отрицательный множитель', () => {
    it('возвращает Err для -1', () => {
      const result = ValidateFactorForPriceMultiplication.check(new Decimal(-1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('is_negative');
      }
    });
  });
});
