import { describe, it, expect } from '@jest/globals';
import { isErr } from '@polymarket/result';
import {
  Percentage,
  PercentageService,
  PercentageFormatter,
  PercentageSerializer,
  ValidateFeeForTrading,
  ValidateTotalFee,
  ValidateSpreadRange,
} from '../../../src/percentage/index.js';

describe('Percentage Integration Tests', () => {
  describe('End-to-end: Creating and using percentages', () => {
    it('should create percentage from number and format it', () => {
      const result = PercentageService.create(50);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const pct = result.value;
      expect(pct.toNumber()).toBe(50);
      expect(PercentageFormatter.toPercent(pct)).toBe('50.00%');
      expect(PercentageFormatter.toDecimalFraction(pct)).toBe('0.5000');
      expect(PercentageFormatter.toBasisPoints(pct)).toBe('5000 bp');
    });

    it('should create percentage from decimal fraction', () => {
      const result = PercentageService.fromDecimalFraction(0.25);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const pct = result.value;
      expect(pct.toNumber()).toBe(25);
      expect(PercentageFormatter.toPercent(pct)).toBe('25.00%');
    });

    it('should create percentage from basis points', () => {
      const result = PercentageService.fromBasisPoints(250);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const pct = result.value;
      expect(pct.toNumber()).toBe(2.5);
      expect(PercentageFormatter.toPercent(pct, 1)).toBe('2.5%');
    });
  });

  describe('End-to-end: Math operations', () => {
    it('should add two percentages', () => {
      const pct1Result = PercentageService.create(25);
      const pct2Result = PercentageService.create(30);

      expect(pct1Result.ok && pct2Result.ok).toBe(true);
      if (!pct1Result.ok || !pct2Result.ok) return;

      const sumResult = PercentageService.add(pct1Result.value, pct2Result.value);

      expect(sumResult.ok).toBe(true);
      if (!sumResult.ok) return;

      expect(sumResult.value.toNumber()).toBe(55);
      expect(PercentageFormatter.toPercent(sumResult.value)).toBe('55.00%');
    });

    it('should subtract two percentages', () => {
      const pct1Result = PercentageService.create(75);
      const pct2Result = PercentageService.create(25);

      expect(pct1Result.ok && pct2Result.ok).toBe(true);
      if (!pct1Result.ok || !pct2Result.ok) return;

      const diffResult = PercentageService.subtract(pct1Result.value, pct2Result.value);

      expect(diffResult.ok).toBe(true);
      if (!diffResult.ok) return;

      expect(diffResult.value.toNumber()).toBe(50);
    });

    it('should multiply percentage by factor', () => {
      const pctResult = PercentageService.create(50);

      expect(pctResult.ok).toBe(true);
      if (!pctResult.ok) return;

      const multiplyResult = PercentageService.multiply(pctResult.value, 2);

      expect(multiplyResult.ok).toBe(true);
      if (!multiplyResult.ok) return;

      expect(multiplyResult.value.toNumber()).toBe(100);
    });

    it('should divide percentage by divisor', () => {
      const pctResult = PercentageService.create(100);

      expect(pctResult.ok).toBe(true);
      if (!pctResult.ok) return;

      const divideResult = PercentageService.divide(pctResult.value, 4);

      expect(divideResult.ok).toBe(true);
      if (!divideResult.ok) return;

      expect(divideResult.value.toNumber()).toBe(25);
    });
  });

  describe('End-to-end: Serialization', () => {
    it('should serialize and deserialize percentage', () => {
      const pctResult = PercentageService.create(42.5);

      expect(pctResult.ok).toBe(true);
      if (!pctResult.ok) return;

      const json = PercentageSerializer.toJSON(pctResult.value);
      expect(json).toEqual({ value: '42.5' });

      const deserializeResult = PercentageSerializer.fromJSON(json);
      expect(deserializeResult.ok).toBe(true);
      if (!deserializeResult.ok) return;

      expect(deserializeResult.value.equals(pctResult.value)).toBe(true);
    });

    it('should handle invalid JSON during deserialization', () => {
      const result = PercentageSerializer.fromJSON({ value: 'invalid' });

      expect(result.ok).toBe(false);
      if (!isErr(result)) return;

      expect(result.error.message).toContain('Invalid');
    });
  });

  describe('End-to-end: Rules validation', () => {
    it('should validate trading fee in range', () => {
      const feeResult = PercentageService.create(2.5);

      expect(feeResult.ok).toBe(true);
      if (!feeResult.ok) return;

      const validateResult = ValidateFeeForTrading.check(feeResult.value);
      expect(validateResult.ok).toBe(true);
    });

    it('should reject negative trading fee', () => {
      const feeResult = PercentageService.create(-1);

      expect(feeResult.ok).toBe(true);
      if (!feeResult.ok) return;

      const validateResult = ValidateFeeForTrading.check(feeResult.value);
      expect(validateResult.ok).toBe(false);
      if (!isErr(validateResult)) return;

      expect(validateResult.error.context?.reason).toBe('NEGATIVE_FEE');
    });

    it('should reject trading fee exceeding 5%', () => {
      const feeResult = PercentageService.create(6);

      expect(feeResult.ok).toBe(true);
      if (!feeResult.ok) return;

      const validateResult = ValidateFeeForTrading.check(feeResult.value);
      expect(validateResult.ok).toBe(false);
      if (!isErr(validateResult)) return;

      expect(validateResult.error.context?.reason).toBe('EXCEEDS_MAX_FEE');
    });

    it('should validate total fee <= 10%', () => {
      const fee1Result = PercentageService.create(4);
      const fee2Result = PercentageService.create(5);

      expect(fee1Result.ok && fee2Result.ok).toBe(true);
      if (!fee1Result.ok || !fee2Result.ok) return;

      const totalResult = PercentageService.add(fee1Result.value, fee2Result.value);
      expect(totalResult.ok).toBe(true);
      if (!totalResult.ok) return;

      const validateResult = ValidateTotalFee.check(totalResult.value);
      expect(validateResult.ok).toBe(true);
    });

    it('should reject total fee > 10%', () => {
      const fee1Result = PercentageService.create(6);
      const fee2Result = PercentageService.create(5);

      expect(fee1Result.ok && fee2Result.ok).toBe(true);
      if (!fee1Result.ok || !fee2Result.ok) return;

      const totalResult = PercentageService.add(fee1Result.value, fee2Result.value);
      expect(totalResult.ok).toBe(true);
      if (!totalResult.ok) return;

      const validateResult = ValidateTotalFee.check(totalResult.value);
      expect(validateResult.ok).toBe(false);
      if (!isErr(validateResult)) return;

      expect(validateResult.error.context?.reason).toBe('EXCEEDS_MAX_TOTAL_FEE');
    });

    it('should validate spread in range', () => {
      const spreadResult = PercentageService.create(5);

      expect(spreadResult.ok).toBe(true);
      if (!spreadResult.ok) return;

      const validateResult = ValidateSpreadRange.check(spreadResult.value);
      expect(validateResult.ok).toBe(true);
    });

    it('should reject spread below minimum', () => {
      const spreadResult = PercentageService.create(-1);

      expect(spreadResult.ok).toBe(true);
      if (!spreadResult.ok) return;

      const validateResult = ValidateSpreadRange.check(spreadResult.value);
      expect(validateResult.ok).toBe(false);
      if (!isErr(validateResult)) return;

      expect(validateResult.error.context?.reason).toBe('BELOW_MIN_SPREAD');
    });

    it('should reject spread exceeding maximum', () => {
      const spreadResult = PercentageService.create(15);

      expect(spreadResult.ok).toBe(true);
      if (!spreadResult.ok) return;

      const validateResult = ValidateSpreadRange.check(spreadResult.value);
      expect(validateResult.ok).toBe(false);
      if (!isErr(validateResult)) return;

      expect(validateResult.error.context?.reason).toBe('EXCEEDS_MAX_SPREAD');
    });
  });

  describe('End-to-end: Error handling', () => {
    it('should handle invalid format gracefully', () => {
      const result = PercentageService.create('invalid');

      expect(result.ok).toBe(false);
      if (!isErr(result)) return;

      expect(result.error.context?.reason).toBe('INVALID_FORMAT');
      expect(result.error.context?.op).toBe('create');
    });

    it('should handle NaN gracefully', () => {
      const result = PercentageService.create(NaN);

      expect(result.ok).toBe(false);
      if (!isErr(result)) return;

      expect(result.error.context?.reason).toBe('NAN');
    });

    it('should handle division by zero', () => {
      const pctResult = PercentageService.create(50);

      expect(pctResult.ok).toBe(true);
      if (!pctResult.ok) return;

      const divideResult = PercentageService.divide(pctResult.value, 0);

      expect(divideResult.ok).toBe(false);
      if (!isErr(divideResult)) return;

      expect(divideResult.error.context?.reason).toBe('DIVISION_BY_ZERO');
    });
  });

  describe('End-to-end: Constants', () => {
    it('should use ZERO constant', () => {
      const zero = Percentage.ZERO;
      expect(zero.toNumber()).toBe(0);
      expect(zero.isZero()).toBe(true);
      expect(PercentageFormatter.toPercent(zero)).toBe('0.00%');
    });

    it('should use ONE_HUNDRED constant', () => {
      const oneHundred = Percentage.ONE_HUNDRED;
      expect(oneHundred.toNumber()).toBe(100);
      expect(PercentageFormatter.toPercent(oneHundred)).toBe('100.00%');
    });
  });
});
