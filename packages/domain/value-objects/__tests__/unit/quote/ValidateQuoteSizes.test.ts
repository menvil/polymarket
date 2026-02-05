import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { ValidateQuoteSizes } from '../../../src/quote/rules/ValidateQuoteSizes.js';
import { Price } from '../../../src/price/core/Price.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { QuoteErrorReason } from '../../../src/quote/errors/QuoteErrorReason.js';

describe('ValidateQuoteSizes', () => {
  describe('check()', () => {
    it('проходит для валидной двусторонней котировки', () => {
      const bid = Price.of(new Decimal(0.48));
      const bidSize = Quantity.of(new Decimal(100));
      const ask = Price.of(new Decimal(0.52));
      const askSize = Quantity.of(new Decimal(150));

      const result = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);

      expect(result.ok).toBe(true);
    });

    it('проходит для bid-only котировки с positive size', () => {
      const bid = Price.of(new Decimal(0.50));
      const bidSize = Quantity.of(new Decimal(100));

      const result = ValidateQuoteSizes.check(bid, bidSize, null, Quantity.ZERO);

      expect(result.ok).toBe(true);
    });

    it('проходит для ask-only котировки с positive size', () => {
      const ask = Price.of(new Decimal(0.51));
      const askSize = Quantity.of(new Decimal(200));

      const result = ValidateQuoteSizes.check(null, Quantity.ZERO, ask, askSize);

      expect(result.ok).toBe(true);
    });

    it('проходит когда bid null и bidSize zero', () => {
      const ask = Price.of(new Decimal(0.51));
      const askSize = Quantity.of(new Decimal(200));

      const result = ValidateQuoteSizes.check(null, Quantity.ZERO, ask, askSize);

      expect(result.ok).toBe(true);
    });

    it('проходит когда ask null и askSize zero', () => {
      const bid = Price.of(new Decimal(0.50));
      const bidSize = Quantity.of(new Decimal(100));

      const result = ValidateQuoteSizes.check(bid, bidSize, null, Quantity.ZERO);

      expect(result.ok).toBe(true);
    });

    it('фэйлится когда bid определён но bidSize zero', () => {
      const bid = Price.of(new Decimal(0.50));
      const bidSize = Quantity.ZERO; // ❌
      const ask = Price.of(new Decimal(0.51));
      const askSize = Quantity.of(new Decimal(200));

      const result = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.BID_SIZE_MUST_BE_POSITIVE);
        expect(result.error.context?.bidValue).toBe(0.50);
        expect(result.error.context?.bidSize).toBe(0);
      }
    });

    it('фэйлится когда ask определён но askSize zero', () => {
      const bid = Price.of(new Decimal(0.50));
      const bidSize = Quantity.of(new Decimal(100));
      const ask = Price.of(new Decimal(0.51));
      const askSize = Quantity.ZERO; // ❌

      const result = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.ASK_SIZE_MUST_BE_POSITIVE);
        expect(result.error.context?.askValue).toBe(0.51);
        expect(result.error.context?.askSize).toBe(0);
      }
    });
  });
});
