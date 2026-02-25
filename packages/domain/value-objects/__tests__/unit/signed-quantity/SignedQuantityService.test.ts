import { SignedQuantityService } from '../../../src/signed-quantity/facade/SignedQuantityService.js';
import { SignedQuantityErrorReason } from '../../../src/signed-quantity/errors/SignedQuantityErrorReason.js';
import { isErr } from '@polymarket/result';
import Decimal from 'decimal.js';

describe('SignedQuantityService', () => {
  describe('create', () => {
    describe('успешное создание', () => {
      it('should create positive SignedQuantity from number', () => {
        const result = SignedQuantityService.create(10);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(10);
        }
      });

      it('should create negative SignedQuantity from number', () => {
        const result = SignedQuantityService.create(-10);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(-10);
        }
      });

      it('should create zero SignedQuantity', () => {
        const result = SignedQuantityService.create(0);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZero()).toBe(true);
        }
      });

      it('should create SignedQuantity from string', () => {
        const result = SignedQuantityService.create('-123.456');
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(-123.456);
        }
      });

      it('should create SignedQuantity from Decimal', () => {
        const result = SignedQuantityService.create(new Decimal(-999.999));
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(-999.999);
        }
      });

      it('should normalize -0 to 0', () => {
        const result = SignedQuantityService.create(-0);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZero()).toBe(true);
          expect(result.value.value().toString()).toBe('0');
        }
      });
    });

    describe('ошибки валидации', () => {
      it('should fail on NaN', () => {
        const result = SignedQuantityService.create(NaN);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NAN);
        }
      });

      it('should fail on Infinity', () => {
        const result = SignedQuantityService.create(Infinity);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
        }
      });

      it('should fail on -Infinity', () => {
        const result = SignedQuantityService.create(-Infinity);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NON_FINITE);
        }
      });

      it('should fail on invalid string', () => {
        const result = SignedQuantityService.create('not-a-number');
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.INVALID_FORMAT);
        }
      });
    });
  });

  describe('add', () => {
    it('should add two positive quantities', () => {
      const qty1Result = SignedQuantityService.create(10);
      const qty2Result = SignedQuantityService.create(5);

      expect(qty1Result.ok && qty2Result.ok).toBe(true);
      if (qty1Result.ok && qty2Result.ok) {
        const result = SignedQuantityService.add(qty1Result.value, qty2Result.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(15);
        }
      }
    });

    it('should add positive and negative quantities', () => {
      const qty1Result = SignedQuantityService.create(10);
      const qty2Result = SignedQuantityService.create(-3);

      expect(qty1Result.ok && qty2Result.ok).toBe(true);
      if (qty1Result.ok && qty2Result.ok) {
        const result = SignedQuantityService.add(qty1Result.value, qty2Result.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(7);
        }
      }
    });

    it('should add two negative quantities', () => {
      const qty1Result = SignedQuantityService.create(-10);
      const qty2Result = SignedQuantityService.create(-5);

      expect(qty1Result.ok && qty2Result.ok).toBe(true);
      if (qty1Result.ok && qty2Result.ok) {
        const result = SignedQuantityService.add(qty1Result.value, qty2Result.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(-15);
        }
      }
    });

    it('should add to get zero', () => {
      const qty1Result = SignedQuantityService.create(10);
      const qty2Result = SignedQuantityService.create(-10);

      expect(qty1Result.ok && qty2Result.ok).toBe(true);
      if (qty1Result.ok && qty2Result.ok) {
        const result = SignedQuantityService.add(qty1Result.value, qty2Result.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZero()).toBe(true);
        }
      }
    });
  });

  describe('subtract', () => {
    it('should subtract two positive quantities', () => {
      const qty1Result = SignedQuantityService.create(10);
      const qty2Result = SignedQuantityService.create(3);

      expect(qty1Result.ok && qty2Result.ok).toBe(true);
      if (qty1Result.ok && qty2Result.ok) {
        const result = SignedQuantityService.subtract(qty1Result.value, qty2Result.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(7);
        }
      }
    });

    it('should allow negative result', () => {
      const qty1Result = SignedQuantityService.create(5);
      const qty2Result = SignedQuantityService.create(10);

      expect(qty1Result.ok && qty2Result.ok).toBe(true);
      if (qty1Result.ok && qty2Result.ok) {
        const result = SignedQuantityService.subtract(qty1Result.value, qty2Result.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(-5);
        }
      }
    });

    it('should subtract negative from positive', () => {
      const qty1Result = SignedQuantityService.create(10);
      const qty2Result = SignedQuantityService.create(-3);

      expect(qty1Result.ok && qty2Result.ok).toBe(true);
      if (qty1Result.ok && qty2Result.ok) {
        const result = SignedQuantityService.subtract(qty1Result.value, qty2Result.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(13);
        }
      }
    });

    it('should subtract to get zero', () => {
      const qty1Result = SignedQuantityService.create(10);
      const qty2Result = SignedQuantityService.create(10);

      expect(qty1Result.ok && qty2Result.ok).toBe(true);
      if (qty1Result.ok && qty2Result.ok) {
        const result = SignedQuantityService.subtract(qty1Result.value, qty2Result.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZero()).toBe(true);
        }
      }
    });
  });

  describe('multiply', () => {
    it('should multiply by positive factor', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.multiply(qtyResult.value, 3);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(30);
        }
      }
    });

    it('should multiply negative by positive factor', () => {
      const qtyResult = SignedQuantityService.create(-10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.multiply(qtyResult.value, 3);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(-30);
        }
      }
    });

    it('should multiply by negative factor (sign inversion)', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.multiply(qtyResult.value, -1);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(-10);
        }
      }
    });

    it('should multiply by zero', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.multiply(qtyResult.value, 0);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZero()).toBe(true);
        }
      }
    });

    it('should multiply by fractional factor', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.multiply(qtyResult.value, 0.5);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(5);
        }
      }
    });

    it('should fail on NaN factor', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.multiply(qtyResult.value, NaN);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NAN);
        }
      }
    });
  });

  describe('divide', () => {
    it('should divide by positive divisor', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.divide(qtyResult.value, 2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(5);
        }
      }
    });

    it('should divide negative by positive', () => {
      const qtyResult = SignedQuantityService.create(-10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.divide(qtyResult.value, 2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(-5);
        }
      }
    });

    it('should divide by negative divisor (sign inversion)', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.divide(qtyResult.value, -2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(-5);
        }
      }
    });

    it('should fail on division by zero', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.divide(qtyResult.value, 0);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.DIVISION_BY_ZERO);
          expect(result.error.message).toContain('divide by zero');
        }
      }
    });

    it('should fail on NaN divisor', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.divide(qtyResult.value, NaN);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(SignedQuantityErrorReason.NAN);
        }
      }
    });
  });

  describe('abs', () => {
    it('should return absolute value of positive', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.abs(qtyResult.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(10);
        }
      }
    });

    it('should return absolute value of negative', () => {
      const qtyResult = SignedQuantityService.create(-10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.abs(qtyResult.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(10);
        }
      }
    });

    it('should return zero for zero', () => {
      const qtyResult = SignedQuantityService.create(0);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.abs(qtyResult.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZero()).toBe(true);
        }
      }
    });
  });

  describe('negate', () => {
    it('should negate positive to negative', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.negate(qtyResult.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(-10);
        }
      }
    });

    it('should negate negative to positive', () => {
      const qtyResult = SignedQuantityService.create(-10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.negate(qtyResult.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(10);
        }
      }
    });

    it('should negate zero to zero', () => {
      const qtyResult = SignedQuantityService.create(0);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityService.negate(qtyResult.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZero()).toBe(true);
        }
      }
    });

    it('should double negate to original', () => {
      const qtyResult = SignedQuantityService.create(10);

      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result1 = SignedQuantityService.negate(qtyResult.value);
        expect(result1.ok).toBe(true);
        if (result1.ok) {
          const result2 = SignedQuantityService.negate(result1.value);
          expect(result2.ok).toBe(true);
          if (result2.ok) {
            expect(result2.value.toNumber()).toBe(10);
          }
        }
      }
    });
  });

  describe('integration scenarios', () => {
    it('should calculate P&L: position delta with price', () => {
      // Buy 100 shares, sell 50 shares
      const buy = SignedQuantityService.create(100);
      const sell = SignedQuantityService.create(-50);

      expect(buy.ok && sell.ok).toBe(true);
      if (buy.ok && sell.ok) {
        const netPosition = SignedQuantityService.add(buy.value, sell.value);
        expect(netPosition.ok).toBe(true);
        if (netPosition.ok) {
          expect(netPosition.value.toNumber()).toBe(50);
        }
      }
    });

    it('should handle position reversal', () => {
      // Long 100 → Short 200 = Net Short 100
      const long = SignedQuantityService.create(100);
      const short = SignedQuantityService.create(-200);

      expect(long.ok && short.ok).toBe(true);
      if (long.ok && short.ok) {
        const netPosition = SignedQuantityService.add(long.value, short.value);
        expect(netPosition.ok).toBe(true);
        if (netPosition.ok) {
          expect(netPosition.value.toNumber()).toBe(-100);
          expect(netPosition.value.isNegative()).toBe(true);
        }
      }
    });

    it('should calculate percentage of position (take profit)', () => {
      // Close 50% of 100 shares
      const position = SignedQuantityService.create(100);

      expect(position.ok).toBe(true);
      if (position.ok) {
        const toClose = SignedQuantityService.multiply(position.value, -0.5);
        expect(toClose.ok).toBe(true);
        if (toClose.ok) {
          expect(toClose.value.toNumber()).toBe(-50);

          const remaining = SignedQuantityService.add(position.value, toClose.value);
          expect(remaining.ok).toBe(true);
          if (remaining.ok) {
            expect(remaining.value.toNumber()).toBe(50);
          }
        }
      }
    });
  });
});
