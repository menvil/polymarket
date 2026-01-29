import { describe, it, expect } from '@jest/globals';
import { PositionQuantityPolicy } from '../../../../src/quantity/policy/PositionQuantityPolicy.js';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('PositionQuantityPolicy', () => {
  describe('validateForPosition()', () => {
    it('должен вернуть Ok для positive quantity', () => {
      const result = PositionQuantityPolicy.validateForPosition(new Decimal(10));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для 0 (allow zero)', () => {
      const result = PositionQuantityPolicy.validateForPosition(new Decimal(0));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для negative', () => {
      const result = PositionQuantityPolicy.validateForPosition(new Decimal(-1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('cannot be negative');
      }
    });

    it('должен вернуть Err для non-finite', () => {
      const result = PositionQuantityPolicy.validateForPosition(new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be finite');
      }
    });
  });

  describe('validatePartialClose()', () => {
    it('должен вернуть Ok для valid close', () => {
      const result = PositionQuantityPolicy.validatePartialClose(
        new Decimal(10),
        new Decimal(5)
      );
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для close == current (полное закрытие)', () => {
      const result = PositionQuantityPolicy.validatePartialClose(
        new Decimal(10),
        new Decimal(10)
      );
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для closeQuantity > current', () => {
      const result = PositionQuantityPolicy.validatePartialClose(
        new Decimal(10),
        new Decimal(15)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Cannot close');
      }
    });

    it('должен вернуть Err для closeQuantity <= 0', () => {
      const result = PositionQuantityPolicy.validatePartialClose(
        new Decimal(10),
        new Decimal(0)
      );
      expect(result.ok).toBe(false);
    });
  });
});
