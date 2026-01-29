import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { averageDecimal } from '../../../src/decimal/average.js';
import { InvalidOperandError } from '@polymarket/errors';

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

  describe('Input validation', () => {
    it.each([
      ['Infinity', Infinity, 10],
      ['-Infinity', -Infinity, 10],
      ['NaN', NaN, 10],
      ['10', 10, Infinity],
      ['10', 10, -Infinity],
      ['10', 10, NaN],
    ])(
      'should throw InvalidOperandError on invalid operands: a=%s b=%s',
      (_label, a, b) => {
        expect(() => averageDecimal(new Decimal(a), new Decimal(b))).toThrow(
          InvalidOperandError
        );
      }
    );
  });

  describe('Error context', () => {
    it('should include operation details in InvalidOperandError', () => {
      const inf = new Decimal(Infinity);

      expect(() => averageDecimal(inf, new Decimal(10))).toThrow(
        InvalidOperandError
      );

      try {
        averageDecimal(inf, new Decimal(10));
      } catch (error) {
        if (error instanceof InvalidOperandError) {
          expect(error.context).toBeDefined();
          expect(error.context?.operation).toBe('average');
          expect(error.context?.a).toBe('Infinity');
          expect(error.context?.b).toBe('10');
        }
      }
    });
  });
});
