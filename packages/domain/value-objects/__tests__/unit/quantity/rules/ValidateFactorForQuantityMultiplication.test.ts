import { describe, it, expect } from '@jest/globals';
import { ValidateFactorForQuantityMultiplication } from '../../../../src/quantity/rules/ValidateFactorForQuantityMultiplication.js';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('ValidateFactorForQuantityMultiplication', () => {
  describe('check()', () => {
    it('должен вернуть Ok для positive factor', () => {
      const result = ValidateFactorForQuantityMultiplication.check(new Decimal(2));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для 0', () => {
      const result = ValidateFactorForQuantityMultiplication.check(new Decimal(0));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для negative', () => {
      const result = ValidateFactorForQuantityMultiplication.check(new Decimal(-1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('cannot be negative');
      }
    });

    it('должен вернуть Err для Infinity', () => {
      const result = ValidateFactorForQuantityMultiplication.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be finite');
      }
    });

    it('должен вернуть Err для NaN', () => {
      const result = ValidateFactorForQuantityMultiplication.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
    });

    it('должен иметь правильный context format', () => {
      expect.assertions(3);
      const result = ValidateFactorForQuantityMultiplication.check(new Decimal(-1));
      if (!result.ok) {
        const context = result.error.context;
        expect(context).toHaveProperty('factor');
        expect(context?.factor).toBe('-1');
        expect(context).not.toHaveProperty('op');
      }
    });
  });
});
