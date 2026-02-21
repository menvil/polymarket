import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { ValidateMaxSpread } from '../../../src/quote/rules/ValidateMaxSpread.js';
import { QuoteErrorReason } from '../../../src/quote/errors/QuoteErrorReason.js';

describe('ValidateMaxSpread', () => {
  describe('check()', () => {
    it('проходит когда spread меньше максимального', () => {
      const spread = new Decimal(0.05); // 5%
      const maxSpread = new Decimal(0.10); // 10%

      const result = ValidateMaxSpread.check(spread, maxSpread);

      expect(result.ok).toBe(true);
    });

    it('проходит когда spread равен максимальному', () => {
      const spread = new Decimal(0.10);
      const maxSpread = new Decimal(0.10);

      const result = ValidateMaxSpread.check(spread, maxSpread);

      expect(result.ok).toBe(true);
    });

    it('фэйлится когда spread превышает максимальный', () => {
      const spread = new Decimal(0.15); // 15%
      const maxSpread = new Decimal(0.10); // 10%

      const result = ValidateMaxSpread.check(spread, maxSpread);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.SPREAD_TOO_WIDE);
        expect(result.error.context?.spread).toBe(0.15);
        expect(result.error.context?.maxSpread).toBe(0.10);
      }
    });

    it('фэйлится когда spread сильно превышает максимальный', () => {
      const spread = new Decimal(0.50); // 50% - явная ошибка
      const maxSpread = new Decimal(0.10);

      const result = ValidateMaxSpread.check(spread, maxSpread);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.SPREAD_TOO_WIDE);
        expect(result.error.context?.spread).toBe(0.50);
        expect(result.error.context?.maxSpread).toBe(0.10);
      }
    });
  });
});
