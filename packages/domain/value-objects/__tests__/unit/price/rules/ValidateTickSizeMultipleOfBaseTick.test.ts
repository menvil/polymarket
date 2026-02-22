import { describe, it, expect } from '@jest/globals';
import { ValidateTickSizeMultipleOfBaseTick } from '../../../../src/price/rules/ValidateTickSizeMultipleOfBaseTick.js';
import { Price } from '../../../../src/price/core/Price.js';
import Decimal from 'decimal.js';

describe('ValidateTickSizeMultipleOfBaseTick', () => {
  const BASE_TICK = Price.MIN.value(); // 0.0001

  describe('валидные значения (кратны базовому тику)', () => {
    it('должен принять базовый тик 0.0001', () => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal(0.0001));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.0001);
      }
    });

    it('должен принять 0.0002 (кратно базовому тику)', () => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal(0.0002));
      expect(result.ok).toBe(true);
    });

    it('должен принять 0.001 (кратно базовому тику)', () => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal(0.001));
      expect(result.ok).toBe(true);
    });

    it('должен принять 0.01 (кратно базовому тику)', () => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal(0.01));
      expect(result.ok).toBe(true);
    });

    it('должен принять 0.1 (кратно базовому тику)', () => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal(0.1));
      expect(result.ok).toBe(true);
    });
  });

  describe('not_multiple_of_base_tick', () => {
    it('должен вернуть Err для 0.00015 (не кратно)', () => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal(0.00015));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_multiple_of_base_tick');
        expect(result.error.context?.tickSize).toBe('0.00015');
        expect(result.error.context?.baseTick).toBe(BASE_TICK.toString());
        expect(result.error.context).toHaveProperty('quotient');
      }
    });

    it('должен вернуть Err для 0.00025 (не кратно)', () => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal(0.00025));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('not_multiple_of_base_tick');
      }
    });

    it('должен вернуть Err для 0.00011 (не кратно)', () => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal(0.00011));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('not_multiple_of_base_tick');
      }
    });
  });

  describe('делегирование базовой валидации', () => {
    it('должен вернуть Err от ValidateTickSize для отрицательного значения', () => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal(-0.0001));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_positive');
      }
    });

    it('должен вернуть Err от ValidateTickSize для NaN', () => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('is_nan');
      }
    });

    it('должен вернуть Err от ValidateTickSize для exceeds_range', () => {
      const maxAllowed = Price.MAX.value().minus(Price.MIN.value());
      const tooLarge = maxAllowed.plus(Price.MIN.value());
      const result = ValidateTickSizeMultipleOfBaseTick.check(tooLarge);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('exceeds_range');
      }
    });
  });
});
