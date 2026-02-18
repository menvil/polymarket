import { describe, it, expect } from '@jest/globals';
import { ValidateResultNonNegative } from '../../../../src/quantity/rules/ValidateResultNonNegative.js';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('ValidateResultNonNegative', () => {
  describe('check()', () => {
    it('должен вернуть Ok для positive результата', () => {
      const result = ValidateResultNonNegative.check(new Decimal(10));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для 0', () => {
      const result = ValidateResultNonNegative.check(new Decimal(0));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для negative результата', () => {
      const result = ValidateResultNonNegative.check(new Decimal(-1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('cannot be negative');
      }
    });

    it('должен иметь правильный context format', () => {
      expect.assertions(2);
      const result = ValidateResultNonNegative.check(new Decimal(-5.5));
      if (!result.ok) {
        const context = result.error.context;
        expect(context).toHaveProperty('result');
        expect(context?.result).toBe('-5.5');
      }
    });

    it('context НЕ должен содержать op', () => {
      expect.assertions(1);
      const result = ValidateResultNonNegative.check(new Decimal(-1));
      if (!result.ok) {
        expect(result.error.context).not.toHaveProperty('op');
      }
    });

    it('должен вернуть Err для NaN результата', () => {
      const result = ValidateResultNonNegative.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('must be finite');
      }
    });

    it('должен вернуть Err для Infinity результата', () => {
      const result = ValidateResultNonNegative.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('must be finite');
      }
    });
  });
});
