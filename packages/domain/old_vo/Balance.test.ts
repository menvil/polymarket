/**
 * Тесты для Balance value object
 */

import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { unwrap } from '@polymarket/result';
import { Balance } from '../../src/Balance';
import { InvalidMoneyError, CurrencyMismatchError } from '@polymarket/errors';

describe('Balance', () => {
  describe('Construction', () => {
    describe('fromValue with number', () => {
      it('should create balance from positive number', () => {
        const result = Balance.fromValue(1000, 'USDC');

        expect(result.ok).toBe(true);
        if (result.ok) {
          const balance = result.value;
          expect(balance.getAmount()).toBe(1000);
          expect(balance.getCurrency()).toBe('USDC');
        }
      });

      it('should create balance from zero', () => {
        const result = Balance.fromValue(0, 'USDC');

        expect(result.ok).toBe(true);
        if (result.ok) {
          const balance = result.value;
          expect(balance.getAmount()).toBe(0);
        }
      });

      it('should reject negative amount', () => {
        const result = Balance.fromValue(-100, 'USDC');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          const error = result.error;
          expect(error).toBeInstanceOf(InvalidMoneyError);
        }
      });

      it('should reject NaN', () => {
        const result = Balance.fromValue(NaN, 'USDC');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidMoneyError);
        }
      });

      it('should reject Infinity', () => {
        const result = Balance.fromValue(Infinity, 'USDC');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidMoneyError);
        }
      });

      it('should reject empty currency', () => {
        const result = Balance.fromValue(100, '');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidMoneyError);
        }
      });
    });

    describe('fromValue with string', () => {
      it('should create balance from valid string', () => {
        const result = Balance.fromValue('1000.50', 'USDC');

        expect(result.ok).toBe(true);
        if (result.ok) {
          const balance = result.value;
          expect(balance.getAmount()).toBe(1000.50);
        }
      });

      it('should reject invalid string', () => {
        const result = Balance.fromValue('invalid', 'USDC');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidMoneyError);
        }
      });
    });

    describe('fromValue with Decimal', () => {
      it('should create balance from Decimal', () => {
        const result = Balance.fromValue(new Decimal('1000.50'), 'USDC');

        expect(result.ok).toBe(true);
        if (result.ok) {
          const balance = result.value;
          expect(balance.toDecimal().toString()).toBe('1000.5');
        }
      });
    });

    describe('zero', () => {
      it('should create zero balance with default currency', () => {
        const result = Balance.zero();

        expect(result.ok).toBe(true);
        if (result.ok) {
          const balance = result.value;
          expect(balance.getAmount()).toBe(0);
          expect(balance.getCurrency()).toBe('USDC');
          expect(balance.isZero()).toBe(true);
        }
      });

      it('should create zero balance with specified currency', () => {
        const result = Balance.zero('BTC');

        expect(result.ok).toBe(true);
        if (result.ok) {
          const balance = result.value;
          expect(balance.getAmount()).toBe(0);
          expect(balance.getCurrency()).toBe('BTC');
          expect(balance.isZero()).toBe(true);
        }
      });
    });
  });

  describe('Operations', () => {
    describe('hasEnough', () => {
      it('should return true when balance is sufficient', () => {
        const balance = unwrap(Balance.fromValue(1000, 'USDC'));

        expect(balance.hasEnough(500)).toBe(true);
        expect(balance.hasEnough(1000)).toBe(true);
      });

      it('should return false when balance is insufficient', () => {
        const balance = unwrap(Balance.fromValue(1000, 'USDC'));

        expect(balance.hasEnough(1500)).toBe(false);
      });

      it('should work with Decimal', () => {
        const balance = unwrap(Balance.fromValue(1000, 'USDC'));

        expect(balance.hasEnough(new Decimal('500.50'))).toBe(true);
        expect(balance.hasEnough(new Decimal('1500.50'))).toBe(false);
      });
    });

    describe('add', () => {
      it('should add two balances with same currency', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(500, 'USDC'));

        const result = b1.add(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const sum = result.value;
          expect(sum.getAmount()).toBe(1500);
          expect(sum.getCurrency()).toBe('USDC');
        }
      });

      it('should reject adding balances with different currencies', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(500, 'BTC'));

        const result = b1.add(b2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          const error = result.error;
          expect(error).toBeInstanceOf(CurrencyMismatchError);
        }
      });

      it('should not mutate original balances', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(500, 'USDC'));

        b1.add(b2);

        expect(b1.getAmount()).toBe(1000);
        expect(b2.getAmount()).toBe(500);
      });
    });

    describe('subtract', () => {
      it('should subtract two balances with same currency', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(300, 'USDC'));

        const result = b1.subtract(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const diff = result.value;
          expect(diff.getAmount()).toBe(700);
          expect(diff.getCurrency()).toBe('USDC');
        }
      });

      it('should reject subtraction resulting in negative balance', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1500, 'USDC'));

        const result = b1.subtract(b2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          const error = result.error;
          expect(error).toBeInstanceOf(InvalidMoneyError);
          expect(error.context?.available).toBe(1000);
          expect(error.context?.required).toBe(1500);
        }
      });

      it('should reject subtracting balances with different currencies', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(300, 'BTC'));

        const result = b1.subtract(b2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(CurrencyMismatchError);
        }
      });

      it('should not mutate original balances', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(300, 'USDC'));

        b1.subtract(b2);

        expect(b1.getAmount()).toBe(1000);
        expect(b2.getAmount()).toBe(300);
      });
    });
  });

  describe('Equality', () => {
    describe('equals', () => {
      it('should return true for equal balances', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1000, 'USDC'));

        expect(b1.equals(b2)).toBe(true);
      });

      it('should return false for different amounts', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(500, 'USDC'));

        expect(b1.equals(b2)).toBe(false);
      });

      it('should return false for different currencies', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1000, 'BTC'));

        expect(b1.equals(b2)).toBe(false);
      });

      it('should be reflexive', () => {
        const b = unwrap(Balance.fromValue(1000, 'USDC'));

        expect(b.equals(b)).toBe(true);
      });
    });
  });

  describe('Comparisons', () => {
    describe('greaterThan', () => {
      it('should return true when balance is greater', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(500, 'USDC'));

        const result = b1.greaterThan(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('should return false when balance is less', () => {
        const b1 = unwrap(Balance.fromValue(500, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1000, 'USDC'));

        const result = b1.greaterThan(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('should return false when balances are equal', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1000, 'USDC'));

        const result = b1.greaterThan(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('should reject comparing different currencies', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(500, 'BTC'));

        const result = b1.greaterThan(b2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(CurrencyMismatchError);
        }
      });
    });

    describe('lessThan', () => {
      it('should return true when balance is less', () => {
        const b1 = unwrap(Balance.fromValue(500, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1000, 'USDC'));

        const result = b1.lessThan(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('should return false when balance is greater', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(500, 'USDC'));

        const result = b1.lessThan(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('should reject comparing different currencies', () => {
        const b1 = unwrap(Balance.fromValue(500, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1000, 'BTC'));

        const result = b1.lessThan(b2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(CurrencyMismatchError);
        }
      });
    });

    describe('greaterThanOrEqual', () => {
      it('should return true when balance is greater', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(500, 'USDC'));

        const result = b1.greaterThanOrEqual(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('should return true when balances are equal', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1000, 'USDC'));

        const result = b1.greaterThanOrEqual(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('should return false when balance is less', () => {
        const b1 = unwrap(Balance.fromValue(500, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1000, 'USDC'));

        const result = b1.greaterThanOrEqual(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('should reject comparing different currencies', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(500, 'BTC'));

        const result = b1.greaterThanOrEqual(b2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(CurrencyMismatchError);
        }
      });
    });

    describe('lessThanOrEqual', () => {
      it('should return true when balance is less', () => {
        const b1 = unwrap(Balance.fromValue(500, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1000, 'USDC'));

        const result = b1.lessThanOrEqual(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('should return true when balances are equal', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1000, 'USDC'));

        const result = b1.lessThanOrEqual(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(true);
        }
      });

      it('should return false when balance is greater', () => {
        const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
        const b2 = unwrap(Balance.fromValue(500, 'USDC'));

        const result = b1.lessThanOrEqual(b2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(false);
        }
      });

      it('should reject comparing different currencies', () => {
        const b1 = unwrap(Balance.fromValue(500, 'USDC'));
        const b2 = unwrap(Balance.fromValue(1000, 'BTC'));

        const result = b1.lessThanOrEqual(b2);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(CurrencyMismatchError);
        }
      });
    });

    describe('isZero', () => {
      it('should return true for zero balance', () => {
        const balance = unwrap(Balance.fromValue(0, 'USDC'));

        expect(balance.isZero()).toBe(true);
      });

      it('should return false for non-zero balance', () => {
        const balance = unwrap(Balance.fromValue(1000, 'USDC'));

        expect(balance.isZero()).toBe(false);
      });

      it('should return false for very small non-zero balance', () => {
        const balance = unwrap(Balance.fromValue(0.0001, 'USDC'));

        expect(balance.isZero()).toBe(false);
      });
    });

    describe('isPositive', () => {
      it('should return true for positive balance', () => {
        const balance = unwrap(Balance.fromValue(1000, 'USDC'));

        expect(balance.isPositive()).toBe(true);
      });

      it('should return false for zero balance', () => {
        const balance = unwrap(Balance.fromValue(0, 'USDC'));

        expect(balance.isPositive()).toBe(false);
      });

      it('should return true for very small positive balance', () => {
        const balance = unwrap(Balance.fromValue(0.0001, 'USDC'));

        expect(balance.isPositive()).toBe(true);
      });
    });
  });

  describe('Conversion', () => {
    describe('toString', () => {
      it('should format balance as string', () => {
        const balance = unwrap(Balance.fromValue(1000, 'USDC'));

        expect(balance.toString()).toBe('1000 USDC');
      });

      it('should preserve decimal precision', () => {
        const balance = unwrap(Balance.fromValue('1000.50', 'USDC'));

        expect(balance.toString()).toBe('1000.5 USDC');
      });
    });

    describe('toDecimal', () => {
      it('should return Decimal representation', () => {
        const balance = unwrap(Balance.fromValue(1000.50, 'USDC'));
        const decimal = balance.toDecimal();

        expect(decimal).toBeInstanceOf(Decimal);
        expect(decimal.toNumber()).toBe(1000.50);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle very small amounts', () => {
      const result = Balance.fromValue(0.0001, 'USDC');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getAmount()).toBe(0.0001);
      }
    });

    it('should handle large amounts', () => {
      const result = Balance.fromValue(1e15, 'USDC');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getAmount()).toBe(1e15);
      }
    });

    it('should handle floating point precision with Decimal', () => {
      const b1 = unwrap(Balance.fromValue('0.1', 'USDC'));
      const b2 = unwrap(Balance.fromValue('0.2', 'USDC'));

      const sum = unwrap(b1.add(b2));

      // С Decimal.js это должно быть точно 0.3, а не 0.30000000000000004
      expect(sum.toDecimal().toString()).toBe('0.3');
    });
  });

  describe('Serialization', () => {
    describe('toJSON', () => {
      it('should return object with amount as string and currency', () => {
        const balance = unwrap(Balance.fromValue(1000, 'USDC'));
        const json = balance.toJSON();

        expect(json).toEqual({
          amount: '1000',
          currency: 'USDC'
        });
      });

      it('should preserve decimal precision in amount string', () => {
        const balance = unwrap(Balance.fromValue('1000.50', 'USDC'));
        const json = balance.toJSON();

        expect(json.amount).toBe('1000.5');
        expect(json.currency).toBe('USDC');
      });

      it('should serialize zero balance', () => {
        const balance = unwrap(Balance.fromValue(0, 'USDC'));
        const json = balance.toJSON();

        expect(json).toEqual({
          amount: '0',
          currency: 'USDC'
        });
      });

      it('should serialize very small amounts', () => {
        const balance = unwrap(Balance.fromValue('0.0001', 'USDC'));
        const json = balance.toJSON();

        expect(json.amount).toBe('0.0001');
      });

      it('should serialize large amounts', () => {
        const balance = unwrap(Balance.fromValue('1000000000000000', 'USDC'));
        const json = balance.toJSON();

        expect(json.amount).toBe('1000000000000000');
      });
    });

    describe('fromJSON', () => {
      it('should deserialize valid JSON with amount string', () => {
        const json = { amount: '1000', currency: 'USDC' };
        const result = Balance.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(1000);
          expect(result.value.getCurrency()).toBe('USDC');
        }
      });

      it('should deserialize decimal amounts', () => {
        const json = { amount: '1000.50', currency: 'USDC' };
        const result = Balance.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('1000.5');
          expect(result.value.getCurrency()).toBe('USDC');
        }
      });

      it('should deserialize zero balance', () => {
        const json = { amount: '0', currency: 'USDC' };
        const result = Balance.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getAmount()).toBe(0);
        }
      });

      it('should reject invalid amount string', () => {
        const json = { amount: 'invalid', currency: 'USDC' };
        const result = Balance.fromJSON(json);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidMoneyError);
        }
      });

      it('should reject negative amount', () => {
        const json = { amount: '-100', currency: 'USDC' };
        const result = Balance.fromJSON(json);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidMoneyError);
        }
      });

      it('should deserialize different currencies', () => {
        const usdcJson = { amount: '100', currency: 'USDC' };
        const usdcResult = Balance.fromJSON(usdcJson);

        const daiJson = { amount: '200', currency: 'DAI' };
        const daiResult = Balance.fromJSON(daiJson);

        expect(usdcResult.ok).toBe(true);
        expect(daiResult.ok).toBe(true);

        if (usdcResult.ok && daiResult.ok) {
          expect(usdcResult.value.getCurrency()).toBe('USDC');
          expect(daiResult.value.getCurrency()).toBe('DAI');
        }
      });
    });

    describe('Round-trip', () => {
      it('should maintain equality after serialization and deserialization', () => {
        const original = unwrap(Balance.fromValue(1000, 'USDC'));
        const deserialized = unwrap(Balance.fromJSON(original.toJSON()));

        expect(original.equals(deserialized)).toBe(true);
      });

      it('should preserve decimal precision in round-trip', () => {
        const original = unwrap(Balance.fromValue('1000.123456789', 'USDC'));
        const deserialized = unwrap(Balance.fromJSON(original.toJSON()));

        expect(original.equals(deserialized)).toBe(true);
        expect(original.toDecimal().toString()).toBe(deserialized.toDecimal().toString());
        expect(deserialized.toDecimal().toString()).toBe('1000.123456789');
      });

      it('should preserve zero balance in round-trip', () => {
        const original = unwrap(Balance.fromValue(0, 'USDC'));
        const deserialized = unwrap(Balance.fromJSON(original.toJSON()));

        expect(original.equals(deserialized)).toBe(true);
        expect(deserialized.getAmount()).toBe(0);
      });

      it('should preserve currency in round-trip', () => {
        const original = unwrap(Balance.fromValue(500, 'DAI'));
        const deserialized = unwrap(Balance.fromJSON(original.toJSON()));

        expect(original.equals(deserialized)).toBe(true);
        expect(deserialized.getCurrency()).toBe('DAI');
      });

      it('should preserve very small amounts in round-trip', () => {
        const original = unwrap(Balance.fromValue('0.000000001', 'USDC'));
        const deserialized = unwrap(Balance.fromJSON(original.toJSON()));

        expect(original.equals(deserialized)).toBe(true);
        expect(original.toDecimal().toString()).toBe(deserialized.toDecimal().toString());
      });

      it('should preserve very large amounts in round-trip', () => {
        const original = unwrap(Balance.fromValue('999999999999999.999', 'USDC'));
        const deserialized = unwrap(Balance.fromJSON(original.toJSON()));

        expect(original.equals(deserialized)).toBe(true);
        expect(original.toDecimal().toString()).toBe(deserialized.toDecimal().toString());
      });

      it('should work with Decimal input in round-trip', () => {
        const original = unwrap(Balance.fromValue(new Decimal('1234.5678'), 'USDC'));
        const deserialized = unwrap(Balance.fromJSON(original.toJSON()));

        expect(original.equals(deserialized)).toBe(true);
        expect(original.toString()).toBe(deserialized.toString());
      });
    });
  });
});