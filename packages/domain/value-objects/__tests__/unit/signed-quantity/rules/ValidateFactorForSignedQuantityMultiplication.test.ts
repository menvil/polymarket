import { describe, it, expect } from '@jest/globals';
import { ValidateFactorForSignedQuantityMultiplication } from '../../../../src/signed-quantity/rules/ValidateFactorForSignedQuantityMultiplication.js';
import { InvalidSignedQuantityError } from '@polymarket/errors';
import { SignedQuantityErrorReason } from '../../../../src/signed-quantity/errors/SignedQuantityErrorReason.js';
import Decimal from 'decimal.js';

describe('ValidateFactorForSignedQuantityMultiplication', () => {
  describe('check()', () => {
    // ==================== Валидные значения ====================

    it('должен вернуть Ok для положительного factor', () => {
      const result = ValidateFactorForSignedQuantityMultiplication.check(new Decimal(2));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для дробного положительного factor', () => {
      const result = ValidateFactorForSignedQuantityMultiplication.check(new Decimal('0.5'));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для нулевого factor (результат = 0)', () => {
      const result = ValidateFactorForSignedQuantityMultiplication.check(new Decimal(0));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для отрицательного factor (инверсия знака)', () => {
      const result = ValidateFactorForSignedQuantityMultiplication.check(new Decimal(-1));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для дробного отрицательного factor', () => {
      const result = ValidateFactorForSignedQuantityMultiplication.check(new Decimal('-0.5'));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для большого factor', () => {
      const result = ValidateFactorForSignedQuantityMultiplication.check(new Decimal('1000000'));
      expect(result.ok).toBe(true);
    });

    // ==================== Не-finite значения ====================

    it('должен вернуть Err с NON_FINITE для Infinity', () => {
      const result = ValidateFactorForSignedQuantityMultiplication.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
      }
    });

    it('должен вернуть Err с NON_FINITE для -Infinity', () => {
      const result = ValidateFactorForSignedQuantityMultiplication.check(new Decimal(-Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
      }
    });

    it('должен вернуть Err с NON_FINITE для NaN', () => {
      const result = ValidateFactorForSignedQuantityMultiplication.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
      }
    });

    // ==================== Context ====================

    it('должен иметь правильный context для NON_FINITE', () => {
      expect.assertions(2);
      const result = ValidateFactorForSignedQuantityMultiplication.check(new Decimal(Infinity));
      if (!result.ok) {
        expect(result.error.context).toHaveProperty('factor');
        expect(result.error.context).toHaveProperty('reason', SignedQuantityErrorReason.NON_FINITE);
      }
    });
  });
});
