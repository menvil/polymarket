import Decimal from 'decimal.js';
import { ValidateMinWidth } from '../../../../src/spread/rules/ValidateMinWidth.js';
import { SpreadErrorReason } from '../../../../src/spread/core/SpreadErrorReason.js';

describe('ValidateMinWidth', () => {
  describe('check()', () => {
    it('should return Ok when width > minWidth', () => {
      const width = new Decimal(0.01);
      const minWidth = new Decimal(0.005);

      const result = ValidateMinWidth.check(width, minWidth);

      expect(result.ok).toBe(true);
    });

    it('should return Ok when width = minWidth (boundary case)', () => {
      const width = new Decimal(0.01);
      const minWidth = new Decimal(0.01);

      const result = ValidateMinWidth.check(width, minWidth);

      expect(result.ok).toBe(true);
    });

    it('should return Err when width < minWidth', () => {
      const width = new Decimal(0.001);
      const minWidth = new Decimal(0.005);

      const result = ValidateMinWidth.check(width, minWidth);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.width).toBe('0.001');
        expect(result.error.context?.minWidth).toBe('0.005');
        expect(result.error.context?.reason).toBe(SpreadErrorReason.WIDTH_TOO_SMALL);
      }
    });

    it('should return Err when minWidth is not finite', () => {
      const width = new Decimal(0.01);
      const minWidth = new Decimal(Infinity);

      const result = ValidateMinWidth.check(width, minWidth);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('minWidth must be finite');
      }
    });

    it('should return Err when minWidth is zero', () => {
      const width = new Decimal(0.01);
      const minWidth = new Decimal(0);

      const result = ValidateMinWidth.check(width, minWidth);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('minWidth must be positive');
      }
    });

    it('should return Err when minWidth is negative', () => {
      const width = new Decimal(0.01);
      const minWidth = new Decimal(-0.01);

      const result = ValidateMinWidth.check(width, minWidth);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('minWidth must be positive');
      }
    });
  });
});
