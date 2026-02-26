import { describe, it, expect } from '@jest/globals';
import { ValidateDeltaForAdjustByNoCrossZero } from '../../../../src/signed-quantity/rules/ValidateDeltaForAdjustByNoCrossZero.js';
import { InvalidSignedQuantityError } from '@polymarket/errors';
import { SignedQuantityErrorReason } from '../../../../src/signed-quantity/errors/SignedQuantityErrorReason.js';
import Decimal from 'decimal.js';

describe('ValidateDeltaForAdjustByNoCrossZero', () => {
  describe('check()', () => {
    it('должен вернуть Ok для positive → positive', () => {
      const result = ValidateDeltaForAdjustByNoCrossZero.check(new Decimal(100), new Decimal(120));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для negative → negative', () => {
      const result = ValidateDeltaForAdjustByNoCrossZero.check(new Decimal(-100), new Decimal(-80));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для positive → zero (граничный случай)', () => {
      const result = ValidateDeltaForAdjustByNoCrossZero.check(new Decimal(100), new Decimal(0));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для negative → zero (граничный случай)', () => {
      const result = ValidateDeltaForAdjustByNoCrossZero.check(new Decimal(-100), new Decimal(0));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err с RESULT_CROSSES_ZERO для positive → negative', () => {
      const result = ValidateDeltaForAdjustByNoCrossZero.check(new Decimal(100), new Decimal(-50));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('crosses zero');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.RESULT_CROSSES_ZERO);
      }
    });

    it('должен вернуть Err с RESULT_CROSSES_ZERO для negative → positive', () => {
      const result = ValidateDeltaForAdjustByNoCrossZero.check(new Decimal(-100), new Decimal(50));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('crosses zero');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.RESULT_CROSSES_ZERO);
      }
    });

    it('должен вернуть Err с CANNOT_ADJUST_ZERO для zero → positive', () => {
      const result = ValidateDeltaForAdjustByNoCrossZero.check(new Decimal(0), new Decimal(10));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('Cannot adjust zero');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.CANNOT_ADJUST_ZERO);
      }
    });

    it('должен вернуть Err с CANNOT_ADJUST_ZERO для zero → negative', () => {
      const result = ValidateDeltaForAdjustByNoCrossZero.check(new Decimal(0), new Decimal(-10));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('Cannot adjust zero');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.CANNOT_ADJUST_ZERO);
      }
    });

    it('должен вернуть Err с CANNOT_ADJUST_ZERO для zero → zero', () => {
      const result = ValidateDeltaForAdjustByNoCrossZero.check(new Decimal(0), new Decimal(0));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.CANNOT_ADJUST_ZERO);
      }
    });

    it('должен иметь правильный context format', () => {
      expect.assertions(3);
      const result = ValidateDeltaForAdjustByNoCrossZero.check(new Decimal(100), new Decimal(-50));
      if (!result.ok) {
        const context = result.error.context;
        expect(context).toHaveProperty('original');
        expect(context).toHaveProperty('result');
        expect(context).not.toHaveProperty('op');
      }
    });
  });
});
