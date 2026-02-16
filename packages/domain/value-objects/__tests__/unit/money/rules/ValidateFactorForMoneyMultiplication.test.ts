import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { ValidateFactorForMoneyMultiplication } from '../../../../src/money/rules/ValidateFactorForMoneyMultiplication';
import { MoneyErrorReason } from '../../../../src/money/errors/MoneyErrorReason';

describe('ValidateFactorForMoneyMultiplication', () => {
  describe('check() - валидные факторы', () => {
    it('должен вернуть Ok для положительного фактора', () => {
      const result = ValidateFactorForMoneyMultiplication.check(new Decimal(2));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для отрицательного фактора', () => {
      const result = ValidateFactorForMoneyMultiplication.check(new Decimal(-1.5));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для нулевого фактора', () => {
      const result = ValidateFactorForMoneyMultiplication.check(new Decimal(0));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для очень большого фактора', () => {
      const result = ValidateFactorForMoneyMultiplication.check(new Decimal('1e10'));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для очень маленького фактора', () => {
      const result = ValidateFactorForMoneyMultiplication.check(new Decimal('0.000001'));
      expect(result.ok).toBe(true);
    });
  });

  describe('check() - невалидные факторы', () => {
    it('должен вернуть Err для NaN', () => {
      const result = ValidateFactorForMoneyMultiplication.check(new Decimal(NaN));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Factor cannot be NaN');
        expect(result.error.context?.reason).toBe(MoneyErrorReason.NAN);
      }
    });

    it('должен вернуть Err для Infinity', () => {
      const result = ValidateFactorForMoneyMultiplication.check(new Decimal(Infinity));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Factor must be finite');
        expect(result.error.context?.reason).toBe(MoneyErrorReason.NON_FINITE);
      }
    });

    it('должен вернуть Err для -Infinity', () => {
      const result = ValidateFactorForMoneyMultiplication.check(new Decimal(-Infinity));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Factor must be finite');
        expect(result.error.context?.reason).toBe(MoneyErrorReason.NON_FINITE);
      }
    });
  });

  describe('error context', () => {
    it('должен содержать factor в context', () => {
      const result = ValidateFactorForMoneyMultiplication.check(new Decimal(NaN));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.factor).toBeDefined();
      }
    });
  });
});
