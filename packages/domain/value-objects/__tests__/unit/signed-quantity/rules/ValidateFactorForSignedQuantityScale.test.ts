import { describe, it, expect } from '@jest/globals';
import { ValidateFactorForSignedQuantityScale } from '../../../../src/signed-quantity/rules/ValidateFactorForSignedQuantityScale.js';
import { InvalidSignedQuantityError } from '@polymarket/errors';
import { SignedQuantityErrorReason } from '../../../../src/signed-quantity/errors/SignedQuantityErrorReason.js';
import Decimal from 'decimal.js';

describe('ValidateFactorForSignedQuantityScale', () => {
  describe('check()', () => {
    it('должен вернуть Ok для positive factor', () => {
      const result = ValidateFactorForSignedQuantityScale.check(new Decimal(2));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для 0', () => {
      const result = ValidateFactorForSignedQuantityScale.check(new Decimal(0));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err с NEGATIVE_SCALE_FACTOR для negative', () => {
      const result = ValidateFactorForSignedQuantityScale.check(new Decimal(-1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('cannot be negative');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NEGATIVE_SCALE_FACTOR);
      }
    });

    it('должен вернуть Err с NON_FINITE для Infinity', () => {
      const result = ValidateFactorForSignedQuantityScale.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
      }
    });

    it('должен вернуть Err с NON_FINITE для NaN', () => {
      const result = ValidateFactorForSignedQuantityScale.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
      }
    });

    it('должен иметь правильный context format', () => {
      expect.assertions(3);
      const result = ValidateFactorForSignedQuantityScale.check(new Decimal(-1));
      if (!result.ok) {
        const context = result.error.context;
        expect(context).toHaveProperty('factor');
        expect(context?.factor).toBe('-1');
        expect(context).not.toHaveProperty('op');
      }
    });
  });
});
