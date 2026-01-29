import { describe, it, expect } from '@jest/globals';
import { ValidateTickSizeForRounding } from '../../../../src/quantity/rules/ValidateTickSizeForRounding.js';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('ValidateTickSizeForRounding', () => {
  describe('check()', () => {
    it('должен вернуть Ok для positive tickSize', () => {
      const result = ValidateTickSizeForRounding.check(new Decimal(0.01));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для 0', () => {
      const result = ValidateTickSizeForRounding.check(new Decimal(0));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('must be positive');
      }
    });

    it('должен вернуть Err для negative', () => {
      const result = ValidateTickSizeForRounding.check(new Decimal(-0.01));
      expect(result.ok).toBe(false);
    });

    it('должен вернуть Err для Infinity', () => {
      const result = ValidateTickSizeForRounding.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be finite');
      }
    });

    it('должен вернуть Err для NaN', () => {
      const result = ValidateTickSizeForRounding.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
    });

    it('должен иметь правильный context format', () => {
      expect.assertions(3);
      const result = ValidateTickSizeForRounding.check(new Decimal(0));
      if (!result.ok) {
        const context = result.error.context;
        expect(context).toHaveProperty('tickSize');
        expect(context?.tickSize).toBe('0');
        expect(context).not.toHaveProperty('op');
      }
    });
  });
});
