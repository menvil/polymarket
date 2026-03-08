import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { ValidateMinSpread } from '../../../src/quote/rules/ValidateMinSpread.js';
import { QuoteErrorReason } from '../../../src/quote/errors/QuoteErrorReason.js';

describe('ValidateMinSpread', () => {
  describe('check()', () => {
    it('проходит когда spread больше минимального', () => {
      const spread = new Decimal(0.002); // 0.2%
      const minSpread = new Decimal(0.001); // 0.1%

      const result = ValidateMinSpread.check(spread, minSpread);

      expect(result.ok).toBe(true);
    });

    it('проходит когда spread равен минимальному', () => {
      const spread = new Decimal(0.001);
      const minSpread = new Decimal(0.001);

      const result = ValidateMinSpread.check(spread, minSpread);

      expect(result.ok).toBe(true);
    });

    it('фэйлится когда spread меньше минимального', () => {
      const spread = new Decimal(0.0005); // 0.05%
      const minSpread = new Decimal(0.001); // 0.1%

      const result = ValidateMinSpread.check(spread, minSpread);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.SPREAD_TOO_NARROW);
        expect(result.error.context?.spread).toBe(0.0005);
        expect(result.error.context?.minSpread).toBe(0.001);
      }
    });

    it('фэйлится когда spread zero и минимальный > 0', () => {
      const spread = new Decimal(0);
      const minSpread = new Decimal(0.001);

      const result = ValidateMinSpread.check(spread, minSpread);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.SPREAD_TOO_NARROW);
      }
    });
  });
});
