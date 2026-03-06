import { describe, it, expect } from '@jest/globals';
import { ValidateStepSizeForSignedQuantity } from '../../../../src/signed-quantity/rules/ValidateStepSizeForSignedQuantity.js';
import { InvalidSignedQuantityError } from '@polymarket/errors';
import { SignedQuantityErrorReason } from '../../../../src/signed-quantity/errors/SignedQuantityErrorReason.js';
import Decimal from 'decimal.js';

describe('ValidateStepSizeForSignedQuantity', () => {
  describe('check()', () => {
    it('должен вернуть Ok для positive stepSize', () => {
      const result = ValidateStepSizeForSignedQuantity.check(new Decimal(0.01));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для 1', () => {
      const result = ValidateStepSizeForSignedQuantity.check(new Decimal(1));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для очень маленького positive stepSize', () => {
      const result = ValidateStepSizeForSignedQuantity.check(new Decimal('0.0001'));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err с NON_POSITIVE_STEP_SIZE для нуля', () => {
      const result = ValidateStepSizeForSignedQuantity.check(new Decimal(0));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('must be positive');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_POSITIVE_STEP_SIZE);
      }
    });

    it('должен вернуть Err с NON_POSITIVE_STEP_SIZE для negative stepSize', () => {
      const result = ValidateStepSizeForSignedQuantity.check(new Decimal(-0.01));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('must be positive');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_POSITIVE_STEP_SIZE);
      }
    });

    it('должен вернуть Err с NON_FINITE для Infinity', () => {
      const result = ValidateStepSizeForSignedQuantity.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
      }
    });

    it('должен вернуть Err с NON_FINITE для -Infinity', () => {
      const result = ValidateStepSizeForSignedQuantity.check(new Decimal(-Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
      }
    });

    it('должен вернуть Err с NON_FINITE для NaN', () => {
      const result = ValidateStepSizeForSignedQuantity.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
      }
    });

    it('должен иметь правильный context format', () => {
      expect.assertions(2);
      const result = ValidateStepSizeForSignedQuantity.check(new Decimal(0));
      if (!result.ok) {
        const context = result.error.context;
        expect(context).toHaveProperty('stepSize');
        expect(context).toHaveProperty('reason');
      }
    });
  });
});
