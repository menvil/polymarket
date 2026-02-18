import { describe, it, expect } from '@jest/globals';
import { ValidateStepSizeForQuantity } from '../../../../src/quantity/rules/ValidateStepSizeForQuantity.js';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('ValidateStepSizeForQuantity', () => {
  describe('check()', () => {
    it('должен вернуть Ok для positive stepSize', () => {
      const result = ValidateStepSizeForQuantity.check(new Decimal(0.01));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для 0', () => {
      const result = ValidateStepSizeForQuantity.check(new Decimal(0));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('must be positive');
      }
    });

    it('должен вернуть Err для negative', () => {
      const result = ValidateStepSizeForQuantity.check(new Decimal(-0.01));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('must be positive');
      }
    });

    it('должен вернуть Err для Infinity', () => {
      const result = ValidateStepSizeForQuantity.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.stepSize).toBe('Infinity');
        expect(result.error.context).not.toHaveProperty('op');
      }
    });

    it('должен вернуть Err для -Infinity', () => {
      const result = ValidateStepSizeForQuantity.check(new Decimal(-Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.stepSize).toBe('-Infinity');
        expect(result.error.context).not.toHaveProperty('op');
      }
    });

    it('должен вернуть Err для NaN', () => {
      const result = ValidateStepSizeForQuantity.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.stepSize).toBe('NaN');
        expect(result.error.context).not.toHaveProperty('op');
      }
    });

    it('должен иметь правильный context format', () => {
      expect.assertions(3);
      const result = ValidateStepSizeForQuantity.check(new Decimal(0));
      if (!result.ok) {
        const context = result.error.context;
        expect(context).toHaveProperty('stepSize');
        expect(context?.stepSize).toBe('0');
        expect(context).not.toHaveProperty('op');
      }
    });
  });
});
