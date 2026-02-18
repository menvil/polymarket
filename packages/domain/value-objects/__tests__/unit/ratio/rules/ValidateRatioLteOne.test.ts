import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { isErr } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import { ValidateRatioLteOne } from '../../../../src/ratio/rules/ValidateRatioLteOne';
import { RatioErrorReason } from '../../../../src/ratio/errors/RatioErrorReason';

describe('ValidateRatioLteOne', () => {
  describe('check()', () => {
    it('возвращает Ok для ratio = 1', () => {
      const result = ValidateRatioLteOne.check(new Decimal(1), 'test');
      expect(result.ok).toBe(true);
    });

    it('возвращает Ok для ratio < 1', () => {
      const result = ValidateRatioLteOne.check(new Decimal(0.5), 'test');
      expect(result.ok).toBe(true);
    });

    it('возвращает Ok для ratio = 0', () => {
      const result = ValidateRatioLteOne.check(new Decimal(0), 'test');
      expect(result.ok).toBe(true);
    });

    it('возвращает Ok для negative ratio', () => {
      const result = ValidateRatioLteOne.check(new Decimal(-0.5), 'test');
      expect(result.ok).toBe(true);
    });

    it('возвращает Err для ratio > 1', () => {
      const result = ValidateRatioLteOne.check(new Decimal(1.5), 'test');
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toContain('must be <= 1');
        expect(result.error.context?.reason).toBe(RatioErrorReason.GREATER_THAN_ONE);
        expect(result.error.context?.ratioValue).toBe('1.5');
        expect(result.error.context?.maxAllowed).toBe('1');
      }
    });

    it('error содержит operation в контексте', () => {
      const result = ValidateRatioLteOne.check(new Decimal(2), 'fromPercent');
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.op).toBe('fromPercent');
      }
    });

    it('error содержит source = RULE_VALIDATION в контексте', () => {
      const result = ValidateRatioLteOne.check(new Decimal(2), 'fromPercent');
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.source).toBe(ErrorSource.RULE_VALIDATION);
      }
    });
  });
});
