import { describe, it, expect } from '@jest/globals';
import { ValidateDivisorForQuantityDivision } from '../../../../src/quantity/rules/ValidateDivisorForQuantityDivision.js';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('ValidateDivisorForQuantityDivision', () => {
  describe('check()', () => {
    it('должен вернуть Ok для positive divisor', () => {
      const result = ValidateDivisorForQuantityDivision.check(new Decimal(2));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для 0', () => {
      const result = ValidateDivisorForQuantityDivision.check(new Decimal(0));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('must be positive');
      }
    });

    it('должен вернуть Err для negative', () => {
      const result = ValidateDivisorForQuantityDivision.check(new Decimal(-1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('must be positive');
      }
    });

    it('должен вернуть Err для Infinity', () => {
      const result = ValidateDivisorForQuantityDivision.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be finite');
      }
    });

    it('должен вернуть Err для NaN', () => {
      const result = ValidateDivisorForQuantityDivision.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('must be finite');
      }
    });

    it('должен иметь правильный context format', () => {
      expect.assertions(3);
      const result = ValidateDivisorForQuantityDivision.check(new Decimal(0));
      if (!result.ok) {
        const context = result.error.context;
        expect(context).toHaveProperty('divisor');
        expect(context?.divisor).toBe('0');
        expect(context).not.toHaveProperty('op');
      }
    });
  });
});
