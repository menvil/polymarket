import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { ValidateTickSize } from '../../../../src/shared/price/ValidateTickSize.js';
import { OutcomePrice } from '../../../../src/outcome-price/core/OutcomePrice.js';

/** Предел шага рынка предсказаний — теперь передаётся явно. */
const MAX_TICK = OutcomePrice.MAX.value().minus(OutcomePrice.MIN.value());

describe('ValidateTickSize', () => {
  describe('валидные значения', () => {
    it('должен принять валидный tickSize', () => {
      const result = ValidateTickSize.check(new Decimal(0.0001), MAX_TICK);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.0001);
      }
    });

    it('должен принять tickSize равный maxAllowed', () => {
      const maxAllowed = OutcomePrice.MAX.value().minus(OutcomePrice.MIN.value());
      const result = ValidateTickSize.check(maxAllowed, MAX_TICK);
      expect(result.ok).toBe(true);
    });

    it('должен принять tickSize как Decimal', () => {
      const result = ValidateTickSize.check(new Decimal(0.01), MAX_TICK);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.01);
      }
    });
  });

  describe('is_nan', () => {
    it('должен вернуть Err для NaN', () => {
      const result = ValidateTickSize.check(new Decimal(NaN), MAX_TICK);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('is_nan');
      }
    });
  });

  describe('not_finite', () => {
    it('должен вернуть Err для Infinity', () => {
      const result = ValidateTickSize.check(new Decimal(Infinity), MAX_TICK);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_finite');
      }
    });

    it('должен вернуть Err для -Infinity', () => {
      const result = ValidateTickSize.check(new Decimal(-Infinity), MAX_TICK);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_finite');
      }
    });
  });

  describe('not_positive', () => {
    it('должен вернуть Err для нуля', () => {
      const result = ValidateTickSize.check(new Decimal(0), MAX_TICK);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_positive');
      }
    });

    it('должен вернуть Err для отрицательного значения', () => {
      const result = ValidateTickSize.check(new Decimal(-0.01), MAX_TICK);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_positive');
      }
    });
  });

  describe('exceeds_range', () => {
    it('должен вернуть Err для значения больше maxAllowed', () => {
      const maxAllowed = OutcomePrice.MAX.value().minus(OutcomePrice.MIN.value());
      const tooLarge = maxAllowed.plus(OutcomePrice.MIN.value());
      const result = ValidateTickSize.check(tooLarge, MAX_TICK);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('exceeds_range');
        expect(result.error.context).toHaveProperty('maxAllowed');
        // Правило стало общим: границы конкретного домена в контекст больше
        // не попадают — передаётся только сам предел
        expect(result.error.context).toHaveProperty('maxAllowed');
      }
    });
  });
});
