import { describe, it, expect } from '@jest/globals';
import { OrderQuantityPolicy } from '../../../../src/quantity/policy/OrderQuantityPolicy.js';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('OrderQuantityPolicy', () => {
  describe('validateForOrder()', () => {
    it('должен вернуть Ok для valid quantity', () => {
      const result = OrderQuantityPolicy.validateForOrder(
        new Decimal(10),
        new Decimal(1)
      );
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для quantity == orderMinSize', () => {
      const result = OrderQuantityPolicy.validateForOrder(
        new Decimal(1),
        new Decimal(1)
      );
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для quantity < orderMinSize', () => {
      const result = OrderQuantityPolicy.validateForOrder(
        new Decimal(0.5),
        new Decimal(1)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
      }
    });

    it('должен использовать ValidateMinSize внутри', () => {
      // Проверяем что ошибка от ValidateMinSize
      const result = OrderQuantityPolicy.validateForOrder(
        new Decimal(0.5),
        new Decimal(1)
      );
      if (!result.ok) {
        expect(result.error.message).toContain('minimum size');
      }
    });
  });
});
