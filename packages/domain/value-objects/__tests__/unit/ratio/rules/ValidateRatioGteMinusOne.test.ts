import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { isErr } from '@polymarket/result';
import { ValidateRatioGteMinusOne } from '../../../../src/ratio/rules/ValidateRatioGteMinusOne';
import { RatioErrorReason } from '../../../../src/ratio/errors/RatioErrorReason';

describe('ValidateRatioGteMinusOne', () => {
  describe('валидные значения (>= -1)', () => {
    it('принимает -1 (граница)', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(-1), 'test');
      expect(result.ok).toBe(true);
    });

    it('принимает -0.9999 (почти -1)', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(-0.9999), 'test');
      expect(result.ok).toBe(true);
    });

    it('принимает -0.5 (-50% discount)', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(-0.5), 'test');
      expect(result.ok).toBe(true);
    });

    it('принимает 0', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(0), 'test');
      expect(result.ok).toBe(true);
    });

    it('принимает 0.1 (10% markup)', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(0.1), 'test');
      expect(result.ok).toBe(true);
    });

    it('принимает 1.0 (100% markup)', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(1), 'test');
      expect(result.ok).toBe(true);
    });

    it('принимает большие положительные значения', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(10), 'test');
      expect(result.ok).toBe(true);
    });
  });

  describe('невалидные значения (< -1)', () => {
    it('отклоняет -1.0001 (чуть меньше -1)', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(-1.0001), 'addRate');
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.LESS_THAN_MINUS_ONE);
        expect(result.error.context?.op).toBe('addRate');
        expect(result.error.context?.ratioValue).toBe('-1.0001');
      }
    });

    it('отклоняет -1.5', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(-1.5), 'addRate');
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.LESS_THAN_MINUS_ONE);
      }
    });

    it('отклоняет -2', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(-2), 'applyMarkup');
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.LESS_THAN_MINUS_ONE);
        expect(result.error.context?.op).toBe('applyMarkup');
      }
    });

    it('отклоняет -10', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(-10), 'test');
      expect(isErr(result)).toBe(true);
    });
  });

  describe('сообщения об ошибках', () => {
    it('содержит правильное сообщение', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(-1.5), 'addRate');
      if (isErr(result)) {
        expect(result.error.message).toContain('Ratio must be >= -1');
        expect(result.error.message).toContain('addRate');
        expect(result.error.message).toContain('-1.5');
      }
    });

    it('содержит operation в контексте', () => {
      const result = ValidateRatioGteMinusOne.check(new Decimal(-2), 'customOp');
      if (isErr(result)) {
        expect(result.error.context?.op).toBe('customOp');
      }
    });
  });
});
