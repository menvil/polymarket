import Decimal from 'decimal.js';
import { ValidateMaxWidth } from '../../../../src/spread/rules/ValidateMaxWidth.js';
import { SpreadErrorReason } from '../../../../src/spread/errors/SpreadErrorReason.js';

describe('ValidateMaxWidth', () => {
  describe('check()', () => {
    it('should return Ok when width < maxWidth', () => {
      const width = new Decimal(0.05);
      const maxWidth = new Decimal(0.10);

      const result = ValidateMaxWidth.check(width, maxWidth);

      expect(result.ok).toBe(true);
    });

    it('should return Ok when width = maxWidth (boundary case)', () => {
      const width = new Decimal(0.10);
      const maxWidth = new Decimal(0.10);

      const result = ValidateMaxWidth.check(width, maxWidth);

      expect(result.ok).toBe(true);
    });

    it('should return Err when width > maxWidth', () => {
      const width = new Decimal(0.15);
      const maxWidth = new Decimal(0.10);

      const result = ValidateMaxWidth.check(width, maxWidth);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.width).toBe('0.15');
        expect(result.error.context?.maxWidth).toBe('0.1');
        expect(result.error.context?.reason).toBe(SpreadErrorReason.WIDTH_TOO_LARGE);
      }
    });

    it('should return Err when maxWidth is not finite', () => {
      const width = new Decimal(0.05);
      const maxWidth = new Decimal(Infinity);

      const result = ValidateMaxWidth.check(width, maxWidth);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('maxWidth must be finite');
      }
    });

    it('should return Err when maxWidth is NaN', () => {
      const width = new Decimal(0.05);
      const maxWidth = new Decimal(NaN);

      const result = ValidateMaxWidth.check(width, maxWidth);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('maxWidth must be finite');
      }
    });

    it('should return Err when maxWidth is zero', () => {
      const width = new Decimal(0.05);
      const maxWidth = new Decimal(0);

      const result = ValidateMaxWidth.check(width, maxWidth);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('maxWidth must be positive');
      }
    });

    it('should return Err when maxWidth is negative', () => {
      const width = new Decimal(0.05);
      const maxWidth = new Decimal(-0.10);

      const result = ValidateMaxWidth.check(width, maxWidth);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('maxWidth must be positive');
      }
    });
  });
});
