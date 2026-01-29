import { describe, it, expect } from '@jest/globals';
import { PositionQuantityPolicy } from '../../../../src/quantity/policy/PositionQuantityPolicy.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';
import Decimal from 'decimal.js';

describe('PositionQuantityPolicy', () => {
  describe('validateForPosition()', () => {
    it('должен вернуть Ok для positive quantity', () => {
      const qty = Quantity.of(10);
      const result = PositionQuantityPolicy.validateForPosition(qty);
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для 0 (allow zero)', () => {
      const qty = Quantity.of(0);
      const result = PositionQuantityPolicy.validateForPosition(qty);
      expect(result.ok).toBe(true);
    });

    // Примечание: Проверки negative/non-finite удалены, так как Quantity
    // гарантирует эти свойства через Core инварианты. validateForPosition()
    // теперь принимает Quantity и не дублирует Core валидацию.
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

    it('должен вернуть Err для closeQuantity = 0', () => {
      const result = PositionQuantityPolicy.validatePartialClose(
        new Decimal(10),
        new Decimal(0)
      );
      expect(result.ok).toBe(false);
    });

    it('должен вернуть Err для negative closeQuantity', () => {
      const result = PositionQuantityPolicy.validatePartialClose(
        new Decimal(10),
        new Decimal(-5)
      );
      expect(result.ok).toBe(false);
    });
  });
});
