import Decimal from 'decimal.js';
import { SpreadService } from '../../../../src/spread/facade/SpreadService.js';
import { PriceService } from '../../../../src/price/index.js';
import { SpreadErrorReason } from '../../../../src/spread/errors/SpreadErrorReason.js';

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
        expect(result.value.width().toNumber()).toBe(0.04);
      }
    });

    it('should create spread from string values', () => {
      const result = SpreadService.fromValues('0.48', '0.52');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.width().toNumber()).toBe(0.04);
        expect(result.value.bid().value().toNumber()).toBe(0.48);
        expect(result.value.ask().value().toNumber()).toBe(0.52);
      }
    });

    it('should return Err for invalid string bid (Never Throw)', () => {
      const result = SpreadService.fromValues('abc', '0.52');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.opChain).toContain('SpreadService.fromValues');
        expect(result.error.context?.reason).toBe('INVALID_FORMAT');
        expect(result.error.context?.bidValue).toBe('abc');
      }
    });

    it('should return Err for empty string bid (Never Throw)', () => {
      const result = SpreadService.fromValues('', '0.52');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.opChain).toContain('SpreadService.fromValues');
        expect(result.error.context?.reason).toBe('INVALID_FORMAT');
      }
    });

    it('should return Err for invalid string ask (Never Throw)', () => {
      const result = SpreadService.fromValues('0.48', 'xyz');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.opChain).toContain('SpreadService.fromValues');
        expect(result.error.context?.reason).toBe('INVALID_FORMAT');
        expect(result.error.context?.askValue).toBe('xyz');
      }
    });

    it('should never throw exceptions for any string input', () => {
      expect(() => SpreadService.fromValues('abc', 'xyz')).not.toThrow();
      expect(() => SpreadService.fromValues('', '')).not.toThrow();
      expect(() => SpreadService.fromValues('NaN', 'Infinity')).not.toThrow();
    });

    it('should return Err when bid value is invalid', () => {
      const result = SpreadService.fromValues(1.5, 0.52);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context;

        // opChain should include a call to SpreadService.fromValues
        expect(ctx?.opChain).toContain('SpreadService.fromValues');

        // source should be defined (system boundary)
        expect(ctx?.source).toBeDefined();
        expect(['RULE_VALIDATION', 'SERVICE_CALL', 'core_invariant']).toContain(ctx?.source);

        // reason should be a specific value from PriceErrorReason
        // (1.5 > MAX_PRICE = 0.9999, therefore OUT_OF_RANGE_HIGH)
        expect(ctx?.reason).toBe('OUT_OF_RANGE_HIGH');

        // Context should include bidValue and askValue
        expect(ctx).toMatchObject({
          bidValue: '1.5',
          askValue: '0.52'
        });

        // Error should be InvalidSpreadError (not InvalidPriceError)
        expect(result.error.constructor.name).toBe('InvalidSpreadError');
      }
    });

    it('should return Err when ask value is invalid', () => {
      const result = SpreadService.fromValues(0.48, 1.5);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const ctx = result.error.context;

        // opChain should include a call to SpreadService.fromValues
        expect(ctx?.opChain).toContain('SpreadService.fromValues');

        // source should be defined (system boundary)
        expect(ctx?.source).toBeDefined();
        expect(['RULE_VALIDATION', 'SERVICE_CALL', 'core_invariant']).toContain(ctx?.source);

        // reason should be a specific value from PriceErrorReason
        // (1.5 > MAX_PRICE = 0.9999, therefore OUT_OF_RANGE_HIGH)
        expect(ctx?.reason).toBe('OUT_OF_RANGE_HIGH');

        // Context should include bidValue and askValue
        expect(ctx).toMatchObject({
          bidValue: '0.48',
          askValue: '1.5'
        });

        // Error should be InvalidSpreadError (not InvalidPriceError)
        expect(result.error.constructor.name).toBe('InvalidSpreadError');
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
          expect(result.value.bid().value().toNumber()).toBe(0.49);
          expect(result.value.ask().value().toNumber()).toBe(0.51);
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
          expect(result.value.bid().value().toNumber()).toBe(0.50);
          expect(result.value.ask().value().toNumber()).toBe(0.50);
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
          expect(result.value.bid().value().toNumber()).toBe(0.46);
          expect(result.value.ask().value().toNumber()).toBe(0.54);
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
          expect(result.value.bid().value().toNumber()).toBe(0.53);
          expect(result.value.ask().value().toNumber()).toBe(0.57);
          // Width should remain unchanged
          expect(result.value.width().toNumber()).toBe(0.04);
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
          expect(result.value.bid().value().toNumber()).toBe(0.43);
          expect(result.value.ask().value().toNumber()).toBe(0.47);
          // Width should remain unchanged
          expect(result.value.width().toNumber()).toBe(0.04);
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

  describe('adjustBid()', () => {
    it('should adjust bid up', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const adjusted = SpreadService.adjustBid(spreadResult.value, new Decimal(0.01));
        expect(adjusted.ok).toBe(true);

        if (adjusted.ok) {
          expect(adjusted.value.bid().value()).toEqual(new Decimal(0.49));
          expect(adjusted.value.ask().value()).toEqual(new Decimal(0.52)); // unchanged
          expect(adjusted.value.width()).toEqual(new Decimal(0.03));
        }
      }
    });

    it('should adjust bid down', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const adjusted = SpreadService.adjustBid(spreadResult.value, new Decimal(-0.02));
        expect(adjusted.ok).toBe(true);

        if (adjusted.ok) {
          expect(adjusted.value.bid().value()).toEqual(new Decimal(0.46));
          expect(adjusted.value.ask().value()).toEqual(new Decimal(0.52)); // unchanged
          expect(adjusted.value.width()).toEqual(new Decimal(0.06));
        }
      }
    });

    it('should return Err when new bid > ask', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const adjusted = SpreadService.adjustBid(spreadResult.value, new Decimal(0.10));
        expect(adjusted.ok).toBe(false);

        if (!adjusted.ok) {
          expect(adjusted.error.context?.reason).toBe(SpreadErrorReason.BID_GREATER_THAN_ASK);
        }
      }
    });

    it('should return Err for non-finite amount', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const adjusted = SpreadService.adjustBid(spreadResult.value, NaN);
        expect(adjusted.ok).toBe(false);
      }
    });
  });

  describe('adjustAsk()', () => {
    it('should adjust ask up', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const adjusted = SpreadService.adjustAsk(spreadResult.value, new Decimal(0.02));
        expect(adjusted.ok).toBe(true);

        if (adjusted.ok) {
          expect(adjusted.value.bid().value()).toEqual(new Decimal(0.48)); // unchanged
          expect(adjusted.value.ask().value()).toEqual(new Decimal(0.54));
          expect(adjusted.value.width()).toEqual(new Decimal(0.06));
        }
      }
    });

    it('should adjust ask down', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const adjusted = SpreadService.adjustAsk(spreadResult.value, new Decimal(-0.01));
        expect(adjusted.ok).toBe(true);

        if (adjusted.ok) {
          expect(adjusted.value.bid().value()).toEqual(new Decimal(0.48)); // unchanged
          expect(adjusted.value.ask().value()).toEqual(new Decimal(0.51));
          expect(adjusted.value.width()).toEqual(new Decimal(0.03));
        }
      }
    });

    it('should return Err when new ask < bid', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const adjusted = SpreadService.adjustAsk(spreadResult.value, new Decimal(-0.10));
        expect(adjusted.ok).toBe(false);

        if (!adjusted.ok) {
          expect(adjusted.error.context?.reason).toBe(SpreadErrorReason.BID_GREATER_THAN_ASK);
        }
      }
    });

    it('should return Err for non-finite amount', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const adjusted = SpreadService.adjustAsk(spreadResult.value, Infinity);
        expect(adjusted.ok).toBe(false);
      }
    });
  });

  describe('adjustBidAsk()', () => {
    it('should adjust both bid and ask', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const adjusted = SpreadService.adjustBidAsk(
          spreadResult.value,
          new Decimal(0.01),
          new Decimal(-0.01)
        );
        expect(adjusted.ok).toBe(true);

        if (adjusted.ok) {
          expect(adjusted.value.bid().value()).toEqual(new Decimal(0.49));
          expect(adjusted.value.ask().value()).toEqual(new Decimal(0.51));
          expect(adjusted.value.width()).toEqual(new Decimal(0.02));
        }
      }
    });

    it('should tighten spread when both move inward', () => {
      const spreadResult = SpreadService.fromValues(0.40, 0.60);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const adjusted = SpreadService.adjustBidAsk(
          spreadResult.value,
          new Decimal(0.05),
          new Decimal(-0.05)
        );
        expect(adjusted.ok).toBe(true);

        if (adjusted.ok) {
          expect(adjusted.value.bid().value()).toEqual(new Decimal(0.45));
          expect(adjusted.value.ask().value()).toEqual(new Decimal(0.55));
          expect(adjusted.value.width()).toEqual(new Decimal(0.10));
        }
      }
    });

    it('should return Err when adjustments cause bid > ask', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const adjusted = SpreadService.adjustBidAsk(
          spreadResult.value,
          new Decimal(0.10),
          new Decimal(-0.10)
        );
        expect(adjusted.ok).toBe(false);
      }
    });
  });

  describe('merge()', () => {
    it('should merge two non-overlapping spreads', () => {
      const s1Result = SpreadService.fromValues(0.40, 0.50);
      const s2Result = SpreadService.fromValues(0.60, 0.70);
      expect(s1Result.ok).toBe(true);
      expect(s2Result.ok).toBe(true);

      if (s1Result.ok && s2Result.ok) {
        const merged = SpreadService.merge(s1Result.value, s2Result.value);
        expect(merged.ok).toBe(true);

        if (merged.ok) {
          expect(merged.value.bid().value()).toEqual(new Decimal(0.40)); // min
          expect(merged.value.ask().value()).toEqual(new Decimal(0.70)); // max
          expect(merged.value.width()).toEqual(new Decimal(0.30));
        }
      }
    });

    it('should merge two overlapping spreads', () => {
      const s1Result = SpreadService.fromValues(0.40, 0.60);
      const s2Result = SpreadService.fromValues(0.50, 0.70);
      expect(s1Result.ok).toBe(true);
      expect(s2Result.ok).toBe(true);

      if (s1Result.ok && s2Result.ok) {
        const merged = SpreadService.merge(s1Result.value, s2Result.value);
        expect(merged.ok).toBe(true);

        if (merged.ok) {
          expect(merged.value.bid().value()).toEqual(new Decimal(0.40)); // min
          expect(merged.value.ask().value()).toEqual(new Decimal(0.70)); // max
        }
      }
    });

    it('should be commutative', () => {
      const s1Result = SpreadService.fromValues(0.48, 0.52);
      const s2Result = SpreadService.fromValues(0.50, 0.54);
      expect(s1Result.ok).toBe(true);
      expect(s2Result.ok).toBe(true);

      if (s1Result.ok && s2Result.ok) {
        const merged1 = SpreadService.merge(s1Result.value, s2Result.value);
        const merged2 = SpreadService.merge(s2Result.value, s1Result.value);

        expect(merged1.ok).toBe(true);
        expect(merged2.ok).toBe(true);

        if (merged1.ok && merged2.ok) {
          expect(merged1.value.bid().equals(merged2.value.bid())).toBe(true);
          expect(merged1.value.ask().equals(merged2.value.ask())).toBe(true);
        }
      }
    });

    it('should handle identical spreads', () => {
      const s1Result = SpreadService.fromValues(0.48, 0.52);
      const s2Result = SpreadService.fromValues(0.48, 0.52);
      expect(s1Result.ok).toBe(true);
      expect(s2Result.ok).toBe(true);

      if (s1Result.ok && s2Result.ok) {
        const merged = SpreadService.merge(s1Result.value, s2Result.value);
        expect(merged.ok).toBe(true);

        if (merged.ok) {
          expect(merged.value.bid().value()).toEqual(new Decimal(0.48));
          expect(merged.value.ask().value()).toEqual(new Decimal(0.52));
        }
      }
    });
  });

  describe('intersect()', () => {
    it('should find intersection of overlapping spreads', () => {
      const s1Result = SpreadService.fromValues(0.40, 0.60);
      const s2Result = SpreadService.fromValues(0.50, 0.70);
      expect(s1Result.ok).toBe(true);
      expect(s2Result.ok).toBe(true);

      if (s1Result.ok && s2Result.ok) {
        const intersect = SpreadService.intersect(s1Result.value, s2Result.value);
        expect(intersect.ok).toBe(true);

        if (intersect.ok) {
          expect(intersect.value.bid().value()).toEqual(new Decimal(0.50)); // max
          expect(intersect.value.ask().value()).toEqual(new Decimal(0.60)); // min
          expect(intersect.value.width()).toEqual(new Decimal(0.10));
        }
      }
    });

    it('should return Err for non-overlapping spreads', () => {
      const s1Result = SpreadService.fromValues(0.40, 0.50);
      const s2Result = SpreadService.fromValues(0.60, 0.70);
      expect(s1Result.ok).toBe(true);
      expect(s2Result.ok).toBe(true);

      if (s1Result.ok && s2Result.ok) {
        const intersect = SpreadService.intersect(s1Result.value, s2Result.value);
        expect(intersect.ok).toBe(false);

        if (!intersect.ok) {
          expect(intersect.error.message).toContain('do not intersect');
          expect(intersect.error.context?.reason).toBe(SpreadErrorReason.BID_GREATER_THAN_ASK);
        }
      }
    });

    it('should be commutative', () => {
      const s1Result = SpreadService.fromValues(0.40, 0.60);
      const s2Result = SpreadService.fromValues(0.50, 0.70);
      expect(s1Result.ok).toBe(true);
      expect(s2Result.ok).toBe(true);

      if (s1Result.ok && s2Result.ok) {
        const intersect1 = SpreadService.intersect(s1Result.value, s2Result.value);
        const intersect2 = SpreadService.intersect(s2Result.value, s1Result.value);

        expect(intersect1.ok).toBe(true);
        expect(intersect2.ok).toBe(true);

        if (intersect1.ok && intersect2.ok) {
          expect(intersect1.value.bid().equals(intersect2.value.bid())).toBe(true);
          expect(intersect1.value.ask().equals(intersect2.value.ask())).toBe(true);
        }
      }
    });

    it('should handle identical spreads', () => {
      const s1Result = SpreadService.fromValues(0.48, 0.52);
      const s2Result = SpreadService.fromValues(0.48, 0.52);
      expect(s1Result.ok).toBe(true);
      expect(s2Result.ok).toBe(true);

      if (s1Result.ok && s2Result.ok) {
        const intersect = SpreadService.intersect(s1Result.value, s2Result.value);
        expect(intersect.ok).toBe(true);

        if (intersect.ok) {
          expect(intersect.value.bid().value()).toEqual(new Decimal(0.48));
          expect(intersect.value.ask().value()).toEqual(new Decimal(0.52));
        }
      }
    });

    it('should handle touching spreads (boundary case)', () => {
      const s1Result = SpreadService.fromValues(0.40, 0.50);
      const s2Result = SpreadService.fromValues(0.50, 0.60);
      expect(s1Result.ok).toBe(true);
      expect(s2Result.ok).toBe(true);

      if (s1Result.ok && s2Result.ok) {
        const intersect = SpreadService.intersect(s1Result.value, s2Result.value);
        expect(intersect.ok).toBe(true);

        if (intersect.ok) {
          // Intersection at a single point (0.50)
          expect(intersect.value.bid().value()).toEqual(new Decimal(0.50));
          expect(intersect.value.ask().value()).toEqual(new Decimal(0.50));
          expect(intersect.value.isZeroWidth()).toBe(true);
        }
      }
    });
  });

  // ==========================================================================
  // Ratio-based Operations (Phase 2)
  // ==========================================================================

  describe('fromMidAndWidth()', () => {
    it('should create spread from mid and width', () => {
      const result = SpreadService.fromMidAndWidth(0.50, 0.04);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value()).toEqual(new Decimal(0.48));
        expect(result.value.ask().value()).toEqual(new Decimal(0.52));
        expect(result.value.mid()).toEqual(new Decimal(0.50));
        expect(result.value.width()).toEqual(new Decimal(0.04));
      }
    });

    it('should create zero-width spread when width = 0', () => {
      const result = SpreadService.fromMidAndWidth(0.50, 0);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isZeroWidth()).toBe(true);
        expect(result.value.bid().value()).toEqual(new Decimal(0.50));
        expect(result.value.ask().value()).toEqual(new Decimal(0.50));
      }
    });

    it('should accept Decimal inputs', () => {
      const result = SpreadService.fromMidAndWidth(new Decimal(0.50), new Decimal(0.04));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.width()).toEqual(new Decimal(0.04));
      }
    });

    it('should accept string inputs', () => {
      const result = SpreadService.fromMidAndWidth('0.50', '0.04');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value()).toEqual(new Decimal(0.48));
        expect(result.value.ask().value()).toEqual(new Decimal(0.52));
      }
    });

    it('should return Err when width is negative', () => {
      const result = SpreadService.fromMidAndWidth(0.50, -0.04);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_WIDTH);
      }
    });

    it('should return Err when mid is invalid', () => {
      const result = SpreadService.fromMidAndWidth(NaN, 0.04);

      expect(result.ok).toBe(false);
      // Error from wrapOp - reason may not be preserved
    });

    it('should return Err when width is invalid', () => {
      const result = SpreadService.fromMidAndWidth(0.50, Infinity);

      expect(result.ok).toBe(false);
      // Error from wrapOp - reason may not be preserved
    });

    it('should handle boundary case: width pushes beyond Price limits', () => {
      // mid = 0.50, width = 1.00 → bid = 0, ask = 1.00
      const result = SpreadService.fromMidAndWidth(0.50, 1.00);

      // Should fail because bid = 0 is below MIN_PRICE (0.0001)
      expect(result.ok).toBe(false);
    });
  });

  describe('fromMidAndWidthPercentage()', () => {
    it('should create spread from mid and width percentage', () => {
      const result = SpreadService.fromMidAndWidthPercentage(0.50, 8);
      // width = 0.50 * 0.08 = 0.04

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value()).toEqual(new Decimal(0.48));
        expect(result.value.ask().value()).toEqual(new Decimal(0.52));
        expect(result.value.width()).toEqual(new Decimal(0.04));
      }
    });

    it('should handle small percentages', () => {
      const result = SpreadService.fromMidAndWidthPercentage(0.50, 1);
      // width = 0.50 * 0.01 = 0.005

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.width()).toEqual(new Decimal(0.005));
        expect(result.value.bid().value()).toEqual(new Decimal(0.4975));
        expect(result.value.ask().value()).toEqual(new Decimal(0.5025));
      }
    });

    it('should handle zero percentage', () => {
      const result = SpreadService.fromMidAndWidthPercentage(0.50, 0);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isZeroWidth()).toBe(true);
      }
    });

    it('should accept Decimal and string inputs', () => {
      const result = SpreadService.fromMidAndWidthPercentage(new Decimal('0.50'), '8');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.width()).toEqual(new Decimal(0.04));
      }
    });

    it('should return Err when widthPercentage is invalid', () => {
      const result = SpreadService.fromMidAndWidthPercentage(0.50, NaN);

      expect(result.ok).toBe(false);
    });

    it('should reject negative percentages', () => {
      const result = SpreadService.fromMidAndWidthPercentage(0.50, -10);

      expect(result.ok).toBe(false);
    });

    it('should work with ensureLteOne option', () => {
      // widthPercentage = 50% is valid
      const result1 = SpreadService.fromMidAndWidthPercentage(0.50, 50, { ensureLteOne: true });
      expect(result1.ok).toBe(true);

      // widthPercentage = 150% should fail with ensureLteOne
      const result2 = SpreadService.fromMidAndWidthPercentage(0.50, 150, { ensureLteOne: true });
      expect(result2.ok).toBe(false);
    });

    it('should handle large percentages without ensureLteOne', () => {
      // 200% width of 0.50 = 1.00, which pushes beyond Price bounds
      const result = SpreadService.fromMidAndWidthPercentage(0.50, 200);

      // Should fail due to Price bounds, not Ratio validation
      expect(result.ok).toBe(false);
    });
  });

  describe('widenBy()', () => {
    it('should widen spread by percentage', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52); // width = 0.04
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.widenBy(spreadResult.value, 0.25); // 25%
        // increase = 0.04 * 0.25 = 0.01
        // widen each side by 0.005

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid().value()).toEqual(new Decimal(0.475));
          expect(result.value.ask().value()).toEqual(new Decimal(0.525));
          expect(result.value.width()).toEqual(new Decimal(0.05));
        }
      }
    });

    it('should accept percentage as number (50%)', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52); // width = 0.04
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.widenBy(spreadResult.value, 0.5); // 50%
        // increase = 0.04 * 0.5 = 0.02
        // widen each side by 0.01

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.width()).toEqual(new Decimal(0.06));
        }
      }
    });

    it('should handle zero percentage (no change)', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.widenBy(spreadResult.value, 0);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid().value()).toEqual(new Decimal(0.48));
          expect(result.value.ask().value()).toEqual(new Decimal(0.52));
        }
      }
    });

    it('should accept string input', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.widenBy(spreadResult.value, '0.25');

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.width()).toEqual(new Decimal(0.05));
        }
      }
    });

    it('should return Err when ratio is invalid', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.widenBy(spreadResult.value, NaN);
        expect(result.ok).toBe(false);
      }
    });

    it('should reject negative ratios (negative widening not supported)', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        // Negative ratio would produce negative widen amount, which is rejected by widen()
        const result = SpreadService.widenBy(spreadResult.value, -0.5);
        expect(result.ok).toBe(false);
        // Use tightenBy() instead for reducing width
      }
    });
  });

  describe('tightenBy()', () => {
    it('should tighten spread by percentage', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52); // width = 0.04
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.tightenBy(spreadResult.value, 0.25); // 25%
        // decrease = 0.04 * 0.25 = 0.01
        // tighten each side by 0.005

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid().value()).toEqual(new Decimal(0.485));
          expect(result.value.ask().value()).toEqual(new Decimal(0.515));
          expect(result.value.width()).toEqual(new Decimal(0.03));
        }
      }
    });

    it('should accept percentage as number (50%)', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52); // width = 0.04
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.tightenBy(spreadResult.value, 0.5); // 50%
        // decrease = 0.04 * 0.5 = 0.02
        // tighten each side by 0.01

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.width()).toEqual(new Decimal(0.02));
        }
      }
    });

    it('should handle 100% tightening (collapse to zero width)', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.tightenBy(spreadResult.value, 1.0); // 100%

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZeroWidth()).toBe(true);
          expect(result.value.mid()).toEqual(new Decimal(0.50));
        }
      }
    });

    it('should handle > 100% tightening (capped at zero width)', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.tightenBy(spreadResult.value, 2.0); // 200%

        expect(result.ok).toBe(true);
        if (result.ok) {
          // tighten() caps at halfWidth, so spread collapses to mid
          expect(result.value.isZeroWidth()).toBe(true);
        }
      }
    });

    it('should handle zero percentage (no change)', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.tightenBy(spreadResult.value, 0);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid().value()).toEqual(new Decimal(0.48));
          expect(result.value.ask().value()).toEqual(new Decimal(0.52));
        }
      }
    });

    it('should accept string input', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.tightenBy(spreadResult.value, '0.25');

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.width()).toEqual(new Decimal(0.03));
        }
      }
    });

    it('should return Err when ratio is invalid', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        const result = SpreadService.tightenBy(spreadResult.value, NaN);
        expect(result.ok).toBe(false);
      }
    });

    it('should work with ensureLteOne option', () => {
      const spreadResult = SpreadService.fromValues(0.48, 0.52);
      expect(spreadResult.ok).toBe(true);

      if (spreadResult.ok) {
        // 50% is valid
        const result1 = SpreadService.tightenBy(spreadResult.value, 0.5, { ensureLteOne: true });
        expect(result1.ok).toBe(true);

        // 150% should fail with ensureLteOne
        const result2 = SpreadService.tightenBy(spreadResult.value, 1.5, { ensureLteOne: true });
        expect(result2.ok).toBe(false);
      }
    });
  });
});
