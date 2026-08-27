import { describe, it, expect } from '@jest/globals';
import { ValidateAligned } from '../../../../src/outcome-price/rules/ValidateAligned.js';
import { OutcomePrice } from '../../../../src/outcome-price/core/OutcomePrice.js';
import Decimal from 'decimal.js';

describe('ValidateAligned', () => {
  describe('валидные комбинации (price кратен tickSize)', () => {
    it('должен принять 0.5 с tickSize 0.0001', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = ValidateAligned.check(price, new Decimal(0.0001));
      expect(result.ok).toBe(true);
    });

    it('должен принять 0.5 с tickSize 0.01', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = ValidateAligned.check(price, new Decimal(0.01));
      expect(result.ok).toBe(true);
    });

    it('должен принять 0.5 с tickSize 0.1', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = ValidateAligned.check(price, new Decimal(0.1));
      expect(result.ok).toBe(true);
    });

    it('должен принять 0.5 с tickSize 0.5', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = ValidateAligned.check(price, new Decimal(0.5));
      expect(result.ok).toBe(true);
    });

    it('должен принять 0.1234 с tickSize 0.0001', () => {
      const price = OutcomePrice.of(new Decimal(0.1234));
      const result = ValidateAligned.check(price, new Decimal(0.0001));
      expect(result.ok).toBe(true);
    });

    it('должен принять 0.12 с tickSize 0.01', () => {
      const price = OutcomePrice.of(new Decimal(0.12));
      const result = ValidateAligned.check(price, new Decimal(0.01));
      expect(result.ok).toBe(true);
    });

    it('должен принять минимальную цену с базовым тиком', () => {
      const price = OutcomePrice.MIN;
      const result = ValidateAligned.check(price, OutcomePrice.MIN.value());
      expect(result.ok).toBe(true);
    });

    it('должен принять максимальную цену с базовым тиком', () => {
      const price = OutcomePrice.MAX;
      const result = ValidateAligned.check(price, OutcomePrice.MIN.value());
      expect(result.ok).toBe(true);
    });
  });

  describe('not_aligned', () => {
    it('должен вернуть Err для 0.5 с tickSize 0.3', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = ValidateAligned.check(price, new Decimal(0.3));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('price');
        expect(result.error.context?.reason).toBe('not_aligned');
        expect(result.error.context?.price).toBe('0.5');
        expect(result.error.context?.tickSize).toBe('0.3');
      }
    });

    it('должен вернуть Err для 0.5 с tickSize 0.7', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = ValidateAligned.check(price, new Decimal(0.7));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('not_aligned');
      }
    });

    it('должен вернуть Err для 0.1235 с tickSize 0.01', () => {
      const price = OutcomePrice.of(new Decimal(0.1235));
      const result = ValidateAligned.check(price, new Decimal(0.01));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('not_aligned');
      }
    });

    it('должен вернуть Err для 0.123 с tickSize 0.05', () => {
      const price = OutcomePrice.of(new Decimal(0.123));
      const result = ValidateAligned.check(price, new Decimal(0.05));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('not_aligned');
      }
    });
  });

  describe('делегирование валидации tickSize', () => {
    it('должен вернуть Err от ValidateTickSize для отрицательного tickSize', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = ValidateAligned.check(price, new Decimal(-0.01));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_positive');
      }
    });

    it('должен вернуть Err от ValidateTickSize для NaN tickSize', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = ValidateAligned.check(price, new Decimal(NaN));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('is_nan');
      }
    });

    it('должен вернуть Err от ValidateTickSize для нулевого tickSize', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = ValidateAligned.check(price, new Decimal(0));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_positive');
      }
    });
  });

  describe('использование div().isInteger() для проверки кратности', () => {
    it('должен корректно работать с дробными tickSize', () => {
      const price = OutcomePrice.of(new Decimal(0.15));
      const result = ValidateAligned.check(price, new Decimal(0.05));
      expect(result.ok).toBe(true);
    });

    it('должен корректно работать с малыми tickSize', () => {
      const price = OutcomePrice.of(new Decimal(0.0003));
      const result = ValidateAligned.check(price, new Decimal(0.0001));
      expect(result.ok).toBe(true);
    });
  });
});
