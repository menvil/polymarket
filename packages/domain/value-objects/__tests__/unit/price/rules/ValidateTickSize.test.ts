import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { ValidateTickSize } from '../../../../src/price/rules/ValidateTickSize.js';
import { Price } from '../../../../src/price/core/Price.js';

describe('ValidateTickSize', () => {
  describe('валидные значения', () => {
    it('должен принять валидный tickSize', () => {
      const result = ValidateTickSize.check(0.0001);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.0001);
      }
    });

    it('должен принять tickSize равный maxAllowed', () => {
      const maxAllowed = Price.maxValue().minus(Price.minValue());
      const result = ValidateTickSize.check(maxAllowed);
      expect(result.ok).toBe(true);
    });

    it('должен принять tickSize как Decimal', () => {
      const result = ValidateTickSize.check(new Decimal(0.01));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.01);
      }
    });
  });

  describe('parse_error', () => {
    it('должен вернуть Err для невалидной строки', () => {
      const result = ValidateTickSize.check('invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('parse_error');
      }
    });
  });

  describe('is_nan', () => {
    it('должен вернуть Err для NaN', () => {
      const result = ValidateTickSize.check(NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('is_nan');
      }
    });
  });

  describe('not_finite', () => {
    it('должен вернуть Err для Infinity', () => {
      const result = ValidateTickSize.check(Infinity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_finite');
      }
    });
  });

  describe('not_positive', () => {
    it('должен вернуть Err для нуля', () => {
      const result = ValidateTickSize.check(0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_positive');
      }
    });

    it('должен вернуть Err для отрицательного значения', () => {
      const result = ValidateTickSize.check(-0.01);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_positive');
      }
    });
  });

  describe('exceeds_range', () => {
    it('должен вернуть Err для значения больше maxAllowed', () => {
      const maxAllowed = Price.maxValue().minus(Price.minValue());
      const tooLarge = maxAllowed.plus(0.0001);
      const result = ValidateTickSize.check(tooLarge);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('exceeds_range');
        expect(result.error.context).toHaveProperty('maxAllowed');
        expect(result.error.context).toHaveProperty('minPrice');
        expect(result.error.context).toHaveProperty('maxPrice');
      }
    });
  });
});
