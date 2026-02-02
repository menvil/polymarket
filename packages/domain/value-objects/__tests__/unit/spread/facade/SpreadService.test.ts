import Decimal from 'decimal.js';
import { SpreadService } from '../../../../src/spread/facade/SpreadService.js';
import { PriceService } from '../../../../src/price/index.js';
import { SpreadErrorReason } from '../../../../src/spread/core/SpreadErrorReason.js';

describe('SpreadService', () => {
  // ==========================================================================
  // Factory Methods
  // ==========================================================================

  describe('create()', () => {
    it('should create spread when bid < ask', () => {
      const bidResult = PriceService.create(0.48);
      const askResult = PriceService.create(0.52);
      expect(bidResult.ok && askResult.ok).toBe(true);

      if (bidResult.ok && askResult.ok) {
        const result = SpreadService.create(bidResult.value, askResult.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid().value().toNumber()).toBe(0.48);
          expect(result.value.ask().value().toNumber()).toBe(0.52);
        }
      }
    });

    it('should create spread when bid = ask (zero width)', () => {
      const priceResult = PriceService.create(0.50);
      expect(priceResult.ok).toBe(true);

      if (priceResult.ok) {
        const result = SpreadService.create(priceResult.value, priceResult.value);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.width().toNumber()).toBe(0);
        }
      }
    });

    it('should return Err when bid > ask', () => {
      const bidResult = PriceService.create(0.60);
      const askResult = PriceService.create(0.50);
      expect(bidResult.ok && askResult.ok).toBe(true);

      if (bidResult.ok && askResult.ok) {
        const result = SpreadService.create(bidResult.value, askResult.value);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('create');
          expect(result.error.context?.bid).toBe('0.6');
          expect(result.error.context?.ask).toBe('0.5');
          expect(result.error.context?.reason).toBe(SpreadErrorReason.BID_GREATER_THAN_ASK);
        }
      }
    });
  });

  describe('fromValues()', () => {
    it('should create spread from valid numbers', () => {
      const result = SpreadService.fromValues(0.48, 0.52);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toNumber()).toBe(0.48);
        expect(result.value.ask().value().toNumber()).toBe(0.52);
      }
    });

    it('should create spread from Decimal values', () => {
      const result = SpreadService.fromValues(new Decimal(0.48), new Decimal(0.52));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.width().toNumber()).toBeCloseTo(0.04, 10);
      }
    });

    it('should return Err when bid value is invalid', () => {
      const result = SpreadService.fromValues(1.5, 0.52);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('fromValues');
      }
    });

    it('should return Err when ask value is invalid', () => {
      const result = SpreadService.fromValues(0.48, 1.5);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('fromValues');
      }
    });

    it('should return Err when bid > ask', () => {
      const result = SpreadService.fromValues(0.60, 0.50);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.BID_GREATER_THAN_ASK);
      }
    });
  });

  describe('zero()', () => {
    it('should create spread with zero width', () => {
      const priceResult = PriceService.create(0.50);
      expect(priceResult.ok).toBe(true);

      if (priceResult.ok) {
        const spread = SpreadService.zero(priceResult.value);

        expect(spread.width().toNumber()).toBe(0);
        expect(spread.isZeroWidth()).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Operations - tighten
  // ==========================================================================

  describe('tighten()', () => {
    it('should tighten spread by given amount', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.tighten(spreadResult.value, new Decimal(0.01));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid().value().toNumber()).toBeCloseTo(0.49, 10);
          expect(result.value.ask().value().toNumber()).toBeCloseTo(0.51, 10);
        }
      }
    });

    it('should limit tighten to half width when amount > half width', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        // width = 0.04, half = 0.02, trying to tighten by 0.03
        const result = SpreadService.tighten(spreadResult.value, new Decimal(0.03));

        expect(result.ok).toBe(true);
        if (result.ok) {
          // Should only tighten by 0.02 (half width)
          expect(result.value.bid().value().toNumber()).toBeCloseTo(0.50, 10);
          expect(result.value.ask().value().toNumber()).toBeCloseTo(0.50, 10);
          expect(result.value.isZeroWidth()).toBe(true);
        }
      }
    });

    it('should accept number as amount', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.tighten(spreadResult.value, 0.01);

        expect(result.ok).toBe(true);
      }
    });

    it('should return Err when amount is not finite', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.tighten(spreadResult.value, Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('tighten');
          expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        }
      }
    });

    it('should return Err when amount is negative', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.tighten(spreadResult.value, -0.01);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('tighten');
          expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        }
      }
    });
  });

  // ==========================================================================
  // Operations - widen
  // ==========================================================================

  describe('widen()', () => {
    it('should widen spread by given amount', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.widen(spreadResult.value, new Decimal(0.02));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid().value().toNumber()).toBeCloseTo(0.46, 10);
          expect(result.value.ask().value().toNumber()).toBeCloseTo(0.54, 10);
        }
      }
    });

    it('should accept number as amount', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.widen(spreadResult.value, 0.02);

        expect(result.ok).toBe(true);
      }
    });

    it('should return Err when amount is not finite', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.widen(spreadResult.value, Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('widen');
          expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        }
      }
    });

    it('should return Err when amount is negative', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.widen(spreadResult.value, -0.02);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('widen');
          expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        }
      }
    });

    it('should return Err when widening would exceed price bounds', () => {
      const spreadResult = SpreadService.fromValues(0.0002, 0.9998);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        // Trying to widen beyond bounds
        const result = SpreadService.widen(spreadResult.value, 0.001);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('widen');
        }
      }
    });
  });

  // ==========================================================================
  // Operations - shift
  // ==========================================================================

  describe('shift()', () => {
    it('should shift spread up by positive amount', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.shift(spreadResult.value, new Decimal(0.05));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid().value().toNumber()).toBeCloseTo(0.53, 10);
          expect(result.value.ask().value().toNumber()).toBeCloseTo(0.57, 10);
          // Width should remain unchanged
          expect(result.value.width().toNumber()).toBeCloseTo(0.04, 10);
        }
      }
    });

    it('should shift spread down by negative amount', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.shift(spreadResult.value, new Decimal(-0.05));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid().value().toNumber()).toBeCloseTo(0.43, 10);
          expect(result.value.ask().value().toNumber()).toBeCloseTo(0.47, 10);
          // Width should remain unchanged
          expect(result.value.width().toNumber()).toBeCloseTo(0.04, 10);
        }
      }
    });

    it('should accept number as amount', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.shift(spreadResult.value, 0.05);

        expect(result.ok).toBe(true);
      }
    });

    it('should return Err when amount is not finite', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.shift(spreadResult.value, Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('shift');
          expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        }
      }
    });

    it('should return Err when shifting would exceed price bounds', () => {
      const spreadResult = SpreadService.fromValues(0.9000, 0.9500);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        // Trying to shift up beyond MAX_PRICE
        const result = SpreadService.shift(spreadResult.value, 0.10);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('shift');
        }
      }
    });
  });

  // ==========================================================================
  // Error Contract Tests
  // ==========================================================================

  describe('Error Contract', () => {
    it('should include op in context for all errors', () => {
      // Test create with invalid bid > ask
      const bidResult = PriceService.create(0.60);
      const askResult = PriceService.create(0.50);
      if (bidResult.ok && askResult.ok) {
        const result = SpreadService.create(bidResult.value, askResult.value);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('create');
        }
      }

      // Test fromValues with invalid input
      const result2 = SpreadService.fromValues(1.5, 0.5);
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error.context?.op).toBe('fromValues');
      }
    });

    it('should include reason for Core invariant violations', () => {
      const bidResult = PriceService.create(0.60);
      const askResult = PriceService.create(0.50);
      if (bidResult.ok && askResult.ok) {
        const result = SpreadService.create(bidResult.value, askResult.value);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe(SpreadErrorReason.BID_GREATER_THAN_ASK);
        }
      }
    });

    it('should include operational context (spread, amount) for operations', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      if (spreadResult.ok) {
        const result = SpreadService.tighten(spreadResult.value, -0.01);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('tighten');
          expect(result.error.context?.spread).toBeDefined();
          expect(result.error.context?.amount).toBeDefined();
        }
      }
    });

    it('should never throw exceptions (Never Throw contract)', () => {
      // All these should return Result.Err, not throw
      expect(() => SpreadService.fromValues(NaN, 0.5)).not.toThrow();
      expect(() => SpreadService.fromValues(0.5, NaN)).not.toThrow();
      expect(() => SpreadService.fromValues(Infinity, 0.5)).not.toThrow();

      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      if (spreadResult.ok) {
        expect(() => SpreadService.tighten(spreadResult.value, NaN)).not.toThrow();
        expect(() => SpreadService.widen(spreadResult.value, Infinity)).not.toThrow();
        expect(() => SpreadService.shift(spreadResult.value, NaN)).not.toThrow();
      }
    });
  });
});
