import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { ValidateDivisorForMoneyDivision } from '../../../../src/money/rules/ValidateDivisorForMoneyDivision';
import { MoneyErrorReason } from '../../../../src/money/errors/MoneyErrorReason';

describe('ValidateDivisorForMoneyDivision', () => {
  describe('check() - валидные делители', () => {
    it('должен вернуть Ok для положительного делителя', () => {
      const result = ValidateDivisorForMoneyDivision.check(new Decimal(2));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для отрицательного делителя', () => {
      const result = ValidateDivisorForMoneyDivision.check(new Decimal(-1.5));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для очень большого делителя', () => {
      const result = ValidateDivisorForMoneyDivision.check(new Decimal('1e10'));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для очень маленького положительного делителя', () => {
      const result = ValidateDivisorForMoneyDivision.check(new Decimal('0.000001'));
      expect(result.ok).toBe(true);
    });
  });

  describe('check() - невалидные делители', () => {
    it('должен вернуть Err для нулевого делителя', () => {
      const result = ValidateDivisorForMoneyDivision.check(new Decimal(0));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Cannot divide by zero');
        expect(result.error.context?.reason).toBe(MoneyErrorReason.DIVISION_BY_ZERO);
      }
    });

    it('должен вернуть Err для NaN', () => {
      const result = ValidateDivisorForMoneyDivision.check(new Decimal(NaN));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Divisor cannot be NaN');
        expect(result.error.context?.reason).toBe(MoneyErrorReason.NAN);
      }
    });

    it('должен вернуть Err для Infinity', () => {
      const result = ValidateDivisorForMoneyDivision.check(new Decimal(Infinity));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Divisor must be finite');
        expect(result.error.context?.reason).toBe(MoneyErrorReason.NON_FINITE);
      }
    });

    it('должен вернуть Err для -Infinity', () => {
      const result = ValidateDivisorForMoneyDivision.check(new Decimal(-Infinity));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Divisor must be finite');
        expect(result.error.context?.reason).toBe(MoneyErrorReason.NON_FINITE);
      }
    });
  });

  describe('error context', () => {
    it('должен содержать divisor в context для division by zero', () => {
      const result = ValidateDivisorForMoneyDivision.check(new Decimal(0));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.divisor).toBe('0');
      }
    });

    it('должен содержать divisor в context для NaN', () => {
      const result = ValidateDivisorForMoneyDivision.check(new Decimal(NaN));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.divisor).toBeDefined();
      }
    });
  });
});
