import { describe, it, expect } from '@jest/globals';
import { ValidateMinSize } from '../../../../src/quantity/rules/ValidateMinSize.js';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('ValidateMinSize', () => {
  describe('check()', () => {
    it('должен вернуть Ok для quantity >= minSize', () => {
      const result = ValidateMinSize.check(new Decimal(10), new Decimal(1));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для quantity == minSize', () => {
      const result = ValidateMinSize.check(new Decimal(1), new Decimal(1));
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для quantity < minSize', () => {
      const result = ValidateMinSize.check(new Decimal(0.5), new Decimal(1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
      }
    });

    it('должен иметь правильный context format', () => {
      expect.assertions(4);
      const result = ValidateMinSize.check(new Decimal(0.5), new Decimal(1));
      if (!result.ok) {
        const context = result.error.context;
        expect(context).toHaveProperty('quantity');
        expect(context).toHaveProperty('minSize');
        expect(context?.quantity).toBe('0.5');
        expect(context?.minSize).toBe('1');
      }
    });

    it('context НЕ должен содержать op (op только в facade)', () => {
      expect.assertions(1);
      const result = ValidateMinSize.check(new Decimal(0.5), new Decimal(1));
      if (!result.ok) {
        expect(result.error.context).not.toHaveProperty('op');
      }
    });

    it('должен работать с большими числами', () => {
      const result = ValidateMinSize.check(
        new Decimal("12345678901234567890"),
        new Decimal("1")
      );
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для non-finite minSize', () => {
      const result = ValidateMinSize.check(new Decimal(10), new Decimal(Infinity));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('minSize must be finite');
      }
    });

    it('должен вернуть Err для negative minSize', () => {
      const result = ValidateMinSize.check(new Decimal(10), new Decimal(-1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('minSize must be positive');
      }
    });

    it('должен вернуть Err для zero minSize', () => {
      const result = ValidateMinSize.check(new Decimal(10), new Decimal(0));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('minSize must be positive');
      }
    });

    it('должен вернуть Ok для non-finite quantity (валидация quantity - ответственность Core)', () => {
      // ValidateMinSize не проверяет finiteness quantity - это делает Core
      const result = ValidateMinSize.check(new Decimal(Infinity), new Decimal(1));
      expect(result.ok).toBe(true);
    });
  });
});
