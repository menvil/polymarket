import { describe, it, expect } from '@jest/globals';
import { ValidateDivisorForSignedQuantityDivision } from '../../../../src/signed-quantity/rules/ValidateDivisorForSignedQuantityDivision.js';
import { InvalidSignedQuantityError } from '@polymarket/errors';
import { SignedQuantityErrorReason } from '../../../../src/signed-quantity/errors/SignedQuantityErrorReason.js';
import Decimal from 'decimal.js';

describe('ValidateDivisorForSignedQuantityDivision', () => {
  describe('check()', () => {
    // ==================== Валидные значения ====================

    it('должен вернуть Ok для положительного делителя', () => {
      const result = ValidateDivisorForSignedQuantityDivision.check(new Decimal(2));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для дробного положительного делителя', () => {
      const result = ValidateDivisorForSignedQuantityDivision.check(new Decimal('0.5'));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для отрицательного делителя (допустимо для SignedQuantity)', () => {
      const result = ValidateDivisorForSignedQuantityDivision.check(new Decimal(-2));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для дробного отрицательного делителя', () => {
      const result = ValidateDivisorForSignedQuantityDivision.check(new Decimal('-0.5'));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для большого делителя', () => {
      const result = ValidateDivisorForSignedQuantityDivision.check(new Decimal('999999999.999'));
      expect(result.ok).toBe(true);
    });

    // ==================== Деление на ноль ====================

    it('должен вернуть Err с DIVISION_BY_ZERO для нуля', () => {
      const result = ValidateDivisorForSignedQuantityDivision.check(new Decimal(0));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('divide');
        expect(result.error.message).toContain('zero');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.DIVISION_BY_ZERO);
      }
    });

    // ==================== Не-finite значения ====================

    it('должен вернуть Err с NON_FINITE для Infinity', () => {
      const result = ValidateDivisorForSignedQuantityDivision.check(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
      }
    });

    it('должен вернуть Err с NON_FINITE для -Infinity', () => {
      const result = ValidateDivisorForSignedQuantityDivision.check(new Decimal(-Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
      }
    });

    it('должен вернуть Err с NON_FINITE для NaN', () => {
      const result = ValidateDivisorForSignedQuantityDivision.check(new Decimal(NaN));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidSignedQuantityError);
        expect(result.error.message).toContain('must be finite');
        expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
      }
    });

    // ==================== Context ====================

    it('должен иметь правильный context для DIVISION_BY_ZERO', () => {
      expect.assertions(2);
      const result = ValidateDivisorForSignedQuantityDivision.check(new Decimal(0));
      if (!result.ok) {
        expect(result.error.context).toHaveProperty('divisor', '0');
        expect(result.error.context).toHaveProperty('reason', SignedQuantityErrorReason.DIVISION_BY_ZERO);
      }
    });

    it('должен иметь правильный context для NON_FINITE', () => {
      expect.assertions(2);
      const result = ValidateDivisorForSignedQuantityDivision.check(new Decimal(Infinity));
      if (!result.ok) {
        expect(result.error.context).toHaveProperty('divisor');
        expect(result.error.context).toHaveProperty('reason', SignedQuantityErrorReason.NON_FINITE);
      }
    });
  });
});
