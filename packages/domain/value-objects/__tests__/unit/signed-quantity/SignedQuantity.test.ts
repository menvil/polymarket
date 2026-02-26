import { SignedQuantity } from '../../../src/signed-quantity/core/SignedQuantity.js';
import { SignedQuantityInvariantViolation } from '../../../src/signed-quantity/core/SignedQuantityInvariantViolation.js';
import { SignedQuantityErrorReason } from '../../../src/signed-quantity/errors/SignedQuantityErrorReason.js';
import Decimal from 'decimal.js';

describe('SignedQuantity Core', () => {
  describe('of', () => {
    describe('успешное создание', () => {
      it('should create positive SignedQuantity', () => {
        const qty = SignedQuantity.of(new Decimal(10));
        expect(qty.value().toNumber()).toBe(10);
      });

      it('should create negative SignedQuantity', () => {
        const qty = SignedQuantity.of(new Decimal(-10));
        expect(qty.value().toNumber()).toBe(-10);
      });

      it('should create zero SignedQuantity', () => {
        const qty = SignedQuantity.of(new Decimal(0));
        expect(qty.value().toNumber()).toBe(0);
      });

      it('should normalize -0 to 0', () => {
        const qty = SignedQuantity.of(new Decimal(-0));
        expect(qty.value().toString()).toBe('0');
        expect(qty.isZero()).toBe(true);
      });

      it('should create from very large positive number', () => {
        const qty = SignedQuantity.of(new Decimal('999999999999999'));
        expect(qty.value().toString()).toBe('999999999999999');
      });

      it('should create from very large negative number', () => {
        const qty = SignedQuantity.of(new Decimal('-999999999999999'));
        expect(qty.value().toString()).toBe('-999999999999999');
      });

      it('should create from decimal fraction', () => {
        const qty = SignedQuantity.of(new Decimal('-123.456789'));
        expect(qty.value().toString()).toBe('-123.456789');
      });
    });

    describe('инварианты - должны бросить исключение', () => {
      it('should throw on NaN', () => {
        expect(() => SignedQuantity.of(new Decimal(NaN))).toThrow(SignedQuantityInvariantViolation);
        try {
          SignedQuantity.of(new Decimal(NaN));
        } catch (e) {
          if (e instanceof SignedQuantityInvariantViolation) {
            expect(e.reason).toBe(SignedQuantityErrorReason.NAN);
          }
        }
      });

      it('should throw on Infinity', () => {
        expect(() => SignedQuantity.of(new Decimal(Infinity))).toThrow(SignedQuantityInvariantViolation);
        try {
          SignedQuantity.of(new Decimal(Infinity));
        } catch (e) {
          if (e instanceof SignedQuantityInvariantViolation) {
            expect(e.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
          }
        }
      });

      it('should throw on -Infinity', () => {
        expect(() => SignedQuantity.of(new Decimal(-Infinity))).toThrow(SignedQuantityInvariantViolation);
        try {
          SignedQuantity.of(new Decimal(-Infinity));
        } catch (e) {
          if (e instanceof SignedQuantityInvariantViolation) {
            expect(e.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
          }
        }
      });
    });

    describe('константы', () => {
      it('should have ZERO constant', () => {
        expect(SignedQuantity.ZERO.isZero()).toBe(true);
        expect(SignedQuantity.ZERO.value().toString()).toBe('0');
      });

      it('should have ONE constant', () => {
        expect(SignedQuantity.ONE.value().toNumber()).toBe(1);
        expect(SignedQuantity.ONE.isPositive()).toBe(true);
      });

      it('should have MINUS_ONE constant', () => {
        expect(SignedQuantity.MINUS_ONE.value().toNumber()).toBe(-1);
        expect(SignedQuantity.MINUS_ONE.isNegative()).toBe(true);
      });
    });
  });

  describe('value', () => {
    it('should return Decimal value', () => {
      const qty = SignedQuantity.of(new Decimal(-123.456));
      const value = qty.value();
      expect(value).toBeInstanceOf(Decimal);
      expect(value.toString()).toBe('-123.456');
    });
  });

  describe('toNumber', () => {
    it('should convert to number', () => {
      const qty = SignedQuantity.of(new Decimal(-10.5));
      expect(qty.toNumber()).toBe(-10.5);
    });

    it('should convert zero to number', () => {
      expect(SignedQuantity.ZERO.toNumber()).toBe(0);
    });
  });

  describe('equals', () => {
    it('should return true for equal positive quantities', () => {
      const qty1 = SignedQuantity.of(new Decimal(10));
      const qty2 = SignedQuantity.of(new Decimal(10));
      expect(qty1.equals(qty2)).toBe(true);
    });

    it('should return true for equal negative quantities', () => {
      const qty1 = SignedQuantity.of(new Decimal(-10));
      const qty2 = SignedQuantity.of(new Decimal(-10));
      expect(qty1.equals(qty2)).toBe(true);
    });

    it('should return false for different quantities', () => {
      const qty1 = SignedQuantity.of(new Decimal(10));
      const qty2 = SignedQuantity.of(new Decimal(-10));
      expect(qty1.equals(qty2)).toBe(false);
    });

    it('should return true for normalized zeros', () => {
      const zero1 = SignedQuantity.of(new Decimal(0));
      const zero2 = SignedQuantity.of(new Decimal(-0));
      expect(zero1.equals(zero2)).toBe(true);
    });
  });

  describe('isZero', () => {
    it('should return true for zero', () => {
      expect(SignedQuantity.ZERO.isZero()).toBe(true);
      expect(SignedQuantity.of(new Decimal(0)).isZero()).toBe(true);
    });

    it('should return false for non-zero', () => {
      expect(SignedQuantity.of(new Decimal(1)).isZero()).toBe(false);
      expect(SignedQuantity.of(new Decimal(-1)).isZero()).toBe(false);
    });
  });

  describe('isPositive', () => {
    it('should return true for positive', () => {
      expect(SignedQuantity.of(new Decimal(10)).isPositive()).toBe(true);
      expect(SignedQuantity.ONE.isPositive()).toBe(true);
    });

    it('should return false for zero', () => {
      expect(SignedQuantity.ZERO.isPositive()).toBe(false);
    });

    it('should return false for negative', () => {
      expect(SignedQuantity.of(new Decimal(-10)).isPositive()).toBe(false);
      expect(SignedQuantity.MINUS_ONE.isPositive()).toBe(false);
    });
  });

  describe('isNegative', () => {
    it('should return true for negative', () => {
      expect(SignedQuantity.of(new Decimal(-10)).isNegative()).toBe(true);
      expect(SignedQuantity.MINUS_ONE.isNegative()).toBe(true);
    });

    it('should return false for zero', () => {
      expect(SignedQuantity.ZERO.isNegative()).toBe(false);
    });

    it('should return false for positive', () => {
      expect(SignedQuantity.of(new Decimal(10)).isNegative()).toBe(false);
      expect(SignedQuantity.ONE.isNegative()).toBe(false);
    });
  });

  describe('isLessThan', () => {
    it('should compare correctly', () => {
      const smaller = SignedQuantity.of(new Decimal(-10));
      const larger = SignedQuantity.of(new Decimal(5));
      expect(smaller.isLessThan(larger)).toBe(true);
      expect(larger.isLessThan(smaller)).toBe(false);
    });

    it('should return false for equal', () => {
      const qty1 = SignedQuantity.of(new Decimal(10));
      const qty2 = SignedQuantity.of(new Decimal(10));
      expect(qty1.isLessThan(qty2)).toBe(false);
    });
  });

  describe('isLessThanOrEqual', () => {
    it('should compare correctly', () => {
      const smaller = SignedQuantity.of(new Decimal(-10));
      const larger = SignedQuantity.of(new Decimal(5));
      expect(smaller.isLessThanOrEqual(larger)).toBe(true);
      expect(larger.isLessThanOrEqual(smaller)).toBe(false);
    });

    it('should return true for equal', () => {
      const qty1 = SignedQuantity.of(new Decimal(10));
      const qty2 = SignedQuantity.of(new Decimal(10));
      expect(qty1.isLessThanOrEqual(qty2)).toBe(true);
    });
  });

  describe('isGreaterThan', () => {
    it('should compare correctly', () => {
      const smaller = SignedQuantity.of(new Decimal(-10));
      const larger = SignedQuantity.of(new Decimal(5));
      expect(larger.isGreaterThan(smaller)).toBe(true);
      expect(smaller.isGreaterThan(larger)).toBe(false);
    });

    it('should return false for equal', () => {
      const qty1 = SignedQuantity.of(new Decimal(10));
      const qty2 = SignedQuantity.of(new Decimal(10));
      expect(qty1.isGreaterThan(qty2)).toBe(false);
    });
  });

  describe('isGreaterThanOrEqual', () => {
    it('should compare correctly', () => {
      const smaller = SignedQuantity.of(new Decimal(-10));
      const larger = SignedQuantity.of(new Decimal(5));
      expect(larger.isGreaterThanOrEqual(smaller)).toBe(true);
      expect(smaller.isGreaterThanOrEqual(larger)).toBe(false);
    });

    it('should return true for equal', () => {
      const qty1 = SignedQuantity.of(new Decimal(10));
      const qty2 = SignedQuantity.of(new Decimal(10));
      expect(qty1.isGreaterThanOrEqual(qty2)).toBe(true);
    });
  });

  describe('sign', () => {
    it('should return 1 for positive', () => {
      expect(SignedQuantity.of(new Decimal(10)).sign()).toBe(1);
      expect(SignedQuantity.ONE.sign()).toBe(1);
    });

    it('should return 0 for zero', () => {
      expect(SignedQuantity.ZERO.sign()).toBe(0);
    });

    it('should return -1 for negative', () => {
      expect(SignedQuantity.of(new Decimal(-10)).sign()).toBe(-1);
      expect(SignedQuantity.MINUS_ONE.sign()).toBe(-1);
    });
  });

  describe('abs', () => {
    it('should return absolute value of positive', () => {
      const qty = SignedQuantity.of(new Decimal(10));
      const abs = qty.abs();
      expect(abs.toNumber()).toBe(10);
    });

    it('should return absolute value of negative', () => {
      const qty = SignedQuantity.of(new Decimal(-10));
      const abs = qty.abs();
      expect(abs.toNumber()).toBe(10);
    });

    it('should return zero for zero', () => {
      const abs = SignedQuantity.ZERO.abs();
      expect(abs.toNumber()).toBe(0);
    });

    it('should return SignedQuantity', () => {
      const qty = SignedQuantity.of(new Decimal(-10));
      const abs = qty.abs();
      expect(abs).toBeInstanceOf(SignedQuantity);
      expect(abs.toNumber()).toBe(10);
    });
  });

  describe('neg', () => {
    it('should negate positive to negative', () => {
      const qty = SignedQuantity.of(new Decimal(10));
      const negated = qty.neg();
      expect(negated.toNumber()).toBe(-10);
    });

    it('should negate negative to positive', () => {
      const qty = SignedQuantity.of(new Decimal(-10));
      const negated = qty.neg();
      expect(negated.toNumber()).toBe(10);
    });

    it('should negate zero to zero', () => {
      const negated = SignedQuantity.ZERO.neg();
      expect(negated.isZero()).toBe(true);
    });

    it('should return SignedQuantity', () => {
      const qty = SignedQuantity.of(new Decimal(10));
      const negated = qty.neg();
      expect(negated).toBeInstanceOf(SignedQuantity);
    });

    it('should double negate to original', () => {
      const qty = SignedQuantity.of(new Decimal(10));
      const doubleNegated = qty.neg().neg();
      expect(doubleNegated.equals(qty)).toBe(true);
    });
  });

  describe('immutability', () => {
    it('should not modify original after neg', () => {
      const original = SignedQuantity.of(new Decimal(10));
      const negated = original.neg();
      expect(original.toNumber()).toBe(10);
      expect(negated.toNumber()).toBe(-10);
    });

    it('should share constants', () => {
      const zero1 = SignedQuantity.ZERO;
      const zero2 = SignedQuantity.ZERO;
      expect(zero1).toBe(zero2); // Same instance
    });
  });
});
