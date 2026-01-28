import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { averageDecimal } from '../../../src/decimal/average.js';
import { ArithmeticOverflowError } from '@polymarket/errors';

describe('averageDecimal', () => {
  describe('Success cases', () => {
    it('should calculate average of two positive integers', () => {
      const result = averageDecimal(new Decimal(10), new Decimal(20));
      expect(result.toString()).toBe('15');
    });

    it('should calculate average of two decimals', () => {
      const result = averageDecimal(new Decimal(0.5), new Decimal(0.7));
      expect(result.toString()).toBe('0.6');
    });

    it('should handle identical values', () => {
      const result = averageDecimal(new Decimal(5), new Decimal(5));
      expect(result.toString()).toBe('5');
    });

    it('should handle zero and positive number', () => {
      const result = averageDecimal(new Decimal(0), new Decimal(10));
      expect(result.toString()).toBe('5');
    });

    it('should handle negative and positive (result zero)', () => {
      const result = averageDecimal(new Decimal(-10), new Decimal(10));
      expect(result.toString()).toBe('0');
    });

    it('should handle two negative numbers', () => {
      const result = averageDecimal(new Decimal(-10), new Decimal(-20));
      expect(result.toString()).toBe('-15');
    });

    it('should handle very small numbers', () => {
      const result = averageDecimal(new Decimal(0.0001), new Decimal(0.0003));
      expect(result.toString()).toBe('0.0002');
    });

    it('should handle large numbers within range', () => {
      const result = averageDecimal(new Decimal(1e6), new Decimal(2e6));
      expect(result.toString()).toBe('1500000');
    });

    it('should preserve precision', () => {
      const result = averageDecimal(
        new Decimal('0.123456789'),
        new Decimal('0.987654321')
      );
      expect(result.toString()).toBe('0.555555555');
    });
  });

  describe('Overflow cases', () => {
    it('should throw ArithmeticOverflowError on Infinity operand', () => {
      const inf = new Decimal(Infinity);
      expect(() => averageDecimal(inf, new Decimal(10))).toThrow(
        ArithmeticOverflowError
      );
    });

    it('should throw ArithmeticOverflowError on NaN result', () => {
      const nan = new Decimal(NaN);
      expect(() => averageDecimal(nan, new Decimal(10))).toThrow(
        ArithmeticOverflowError
      );
    });

    it('should throw ArithmeticOverflowError on -Infinity operand', () => {
      const negInf = new Decimal(-Infinity);
      expect(() => averageDecimal(negInf, new Decimal(10))).toThrow(
        ArithmeticOverflowError
      );
    });
  });

  describe('Error context', () => {
    it('should include operation details in error', () => {
      const inf = new Decimal(Infinity);

      try {
        averageDecimal(inf, new Decimal(10));
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ArithmeticOverflowError);
        if (error instanceof ArithmeticOverflowError) {
          expect(error.context).toBeDefined();
          expect(error.context?.operation).toBe('average');
          expect(error.context?.operand1).toBe('Infinity');
          expect(error.context?.operand2).toBe('10');
        }
      }
    });
  });
});
