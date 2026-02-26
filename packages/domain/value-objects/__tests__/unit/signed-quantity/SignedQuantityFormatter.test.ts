import { SignedQuantityFormatter } from '../../../src/signed-quantity/adapters/SignedQuantityFormatter.js';
import { SignedQuantityService } from '../../../src/signed-quantity/facade/SignedQuantityService.js';
import { SignedQuantity } from '../../../src/signed-quantity/core/SignedQuantity.js';
import { isErr } from '@polymarket/result';
import Decimal from 'decimal.js';

describe('SignedQuantityFormatter', () => {
  describe('toString', () => {
    it('should format positive with plus sign by default', () => {
      const qtyResult = SignedQuantityService.create(10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toString(qtyResult.value, 2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe('+10.50');
        }
      }
    });

    it('should format negative with minus sign', () => {
      const qtyResult = SignedQuantityService.create(-10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toString(qtyResult.value, 2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe('-10.50');
        }
      }
    });

    it('should format zero without sign', () => {
      const qtyResult = SignedQuantityService.create(0);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toString(qtyResult.value, 2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe('0.00');
        }
      }
    });

    it('should format positive without plus sign when showPlusSign=false', () => {
      const qtyResult = SignedQuantityService.create(10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toString(qtyResult.value, 2, { showPlusSign: false });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe('10.50');
        }
      }
    });

    it('should fail on invalid decimals', () => {
      const qtyResult = SignedQuantityService.create(10);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toString(qtyResult.value, -1);
        expect(isErr(result)).toBe(true);
      }
    });

    it('should use default decimals=2 when not provided', () => {
      const qtyResult = SignedQuantityService.create(10.567);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toString(qtyResult.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe('+10.57');
        }
      }
    });
  });

  describe('toCompactString', () => {
    it('should format positive with plus sign by default', () => {
      const qtyResult = SignedQuantityService.create(10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toCompactString(qtyResult.value);
        expect(formatted).toBe('+10.5');
      }
    });

    it('should format negative', () => {
      const qtyResult = SignedQuantityService.create(-10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toCompactString(qtyResult.value);
        expect(formatted).toBe('-10.5');
      }
    });

    it('should format zero', () => {
      const qtyResult = SignedQuantityService.create(0);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toCompactString(qtyResult.value);
        expect(formatted).toBe('0');
      }
    });

    it('should format without plus sign when showPlusSign=false', () => {
      const qtyResult = SignedQuantityService.create(10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toCompactString(qtyResult.value, { showPlusSign: false });
        expect(formatted).toBe('10.5');
      }
    });

    it('should use scientific notation for very large numbers', () => {
      // Decimal.toString() использует exponential notation для exponent > 20
      const largeQty = SignedQuantity.of(new Decimal('1e21'));
      const formatted = SignedQuantityFormatter.toCompactString(largeQty);
      expect(formatted).toBe('+1e+21');
    });

    it('should use scientific notation for very small numbers', () => {
      // Decimal.toString() использует exponential notation для exponent < -7
      const smallQty = SignedQuantity.of(new Decimal('1e-8'));
      const formatted = SignedQuantityFormatter.toCompactString(smallQty);
      expect(formatted).toBe('+1e-8');
    });

    it('should use normal notation within Decimal.js range', () => {
      // Типичные размеры для финансовых приложений остаются в нормальной нотации
      const typicalSmall = SignedQuantity.of(new Decimal('0.000001'));
      expect(SignedQuantityFormatter.toCompactString(typicalSmall)).toBe('+0.000001');

      const typicalLarge = SignedQuantity.of(new Decimal('1000000'));
      expect(SignedQuantityFormatter.toCompactString(typicalLarge)).toBe('+1000000');
    });
  });

  describe('toDebugString', () => {
    it('should format positive with plus prefix', () => {
      const qtyResult = SignedQuantityService.create(10);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDebugString(qtyResult.value);
        expect(formatted).toBe('SignedQuantity(+10)');
      }
    });

    it('should format negative', () => {
      const qtyResult = SignedQuantityService.create(-10);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDebugString(qtyResult.value);
        expect(formatted).toBe('SignedQuantity(-10)');
      }
    });

    it('should format zero', () => {
      const qtyResult = SignedQuantityService.create(0);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDebugString(qtyResult.value);
        expect(formatted).toBe('SignedQuantity(0)');
      }
    });
  });

  describe('toFinancialString', () => {
    it('should format positive without parentheses', () => {
      const qtyResult = SignedQuantityService.create(10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toFinancialString(qtyResult.value, 2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe('10.50');
        }
      }
    });

    it('should format negative with parentheses', () => {
      const qtyResult = SignedQuantityService.create(-10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toFinancialString(qtyResult.value, 2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe('(10.50)');
        }
      }
    });

    it('should format zero without parentheses', () => {
      const qtyResult = SignedQuantityService.create(0);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toFinancialString(qtyResult.value, 2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe('0.00');
        }
      }
    });

    it('should fail on invalid decimals (negative)', () => {
      const qtyResult = SignedQuantityService.create(10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toFinancialString(qtyResult.value, -1);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.op).toBe('toFinancialString');
          expect(result.error.context).toHaveProperty('decimalPlaces');
          expect(result.error.message).toContain('must be');
        }
      }
    });

    it('should fail on invalid decimals (too large)', () => {
      const qtyResult = SignedQuantityService.create(10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toFinancialString(qtyResult.value, 101);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.op).toBe('toFinancialString');
          expect(result.error.context).toHaveProperty('decimalPlaces');
        }
      }
    });

    it('should fail on invalid decimals (fractional)', () => {
      const qtyResult = SignedQuantityService.create(10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toFinancialString(qtyResult.value, 1.5);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.op).toBe('toFinancialString');
          expect(result.error.context).toHaveProperty('decimalPlaces');
        }
      }
    });

    it('should use default decimals=2 when not provided', () => {
      const qtyResult = SignedQuantityService.create(10.567);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toFinancialString(qtyResult.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe('10.57');
        }
      }
    });
  });

  describe('toDisplayString', () => {
    it('should format positive small number with plus sign', () => {
      const qtyResult = SignedQuantityService.create(100);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDisplayString(qtyResult.value);
        expect(formatted).toBe('+100.00');
      }
    });

    it('should format negative small number', () => {
      const qtyResult = SignedQuantityService.create(-100);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDisplayString(qtyResult.value);
        expect(formatted).toBe('-100.00');
      }
    });

    it('should format positive thousands with K suffix', () => {
      const qtyResult = SignedQuantityService.create(1500);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDisplayString(qtyResult.value);
        expect(formatted).toBe('+1.50K');
      }
    });

    it('should format negative thousands with K suffix', () => {
      const qtyResult = SignedQuantityService.create(-1500);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDisplayString(qtyResult.value);
        expect(formatted).toBe('-1.50K');
      }
    });

    it('should format positive millions with M suffix', () => {
      const qtyResult = SignedQuantityService.create(1500000);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDisplayString(qtyResult.value);
        expect(formatted).toBe('+1.50M');
      }
    });

    it('should format negative millions with M suffix', () => {
      const qtyResult = SignedQuantityService.create(-1500000);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDisplayString(qtyResult.value);
        expect(formatted).toBe('-1.50M');
      }
    });

    it('should format zero', () => {
      const qtyResult = SignedQuantityService.create(0);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDisplayString(qtyResult.value);
        expect(formatted).toBe('0.00');
      }
    });

    it('should format without plus sign when showPlusSign=false', () => {
      const qtyResult = SignedQuantityService.create(1500);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDisplayString(qtyResult.value, { showPlusSign: false });
        expect(formatted).toBe('1.50K');
      }
    });

    it('should handle boundary at 1000K stays as K', () => {
      const qtyResult = SignedQuantityService.create(999500);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDisplayString(qtyResult.value);
        // 999500 / 1000 = 999.5K → toFixed(2) = "999.50" < 1000 → stays as K
        expect(formatted).toBe('+999.50K');
      }
    });

    it('should rollover from K to M when rounded value >= 1000', () => {
      // 999999.995 / 1000 = 999.999995 → toFixed(2) = "1000.00" → rollover to M
      const qtyResult = SignedQuantityService.create(999999.995);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDisplayString(qtyResult.value);
        expect(formatted).toBe('+1.00M');
      }
    });

    it('should rollover from K to M for negative values', () => {
      const qtyResult = SignedQuantityService.create(-999999.995);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const formatted = SignedQuantityFormatter.toDisplayString(qtyResult.value);
        expect(formatted).toBe('-1.00M');
      }
    });
  });

  describe('toPnLString', () => {
    it('should format positive as profit', () => {
      const qtyResult = SignedQuantityService.create(10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toPnLString(qtyResult.value, 2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe('+10.50');
          expect(result.value.indicator).toBe('profit');
        }
      }
    });

    it('should format negative as loss', () => {
      const qtyResult = SignedQuantityService.create(-10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toPnLString(qtyResult.value, 2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe('-10.50');
          expect(result.value.indicator).toBe('loss');
        }
      }
    });

    it('should format zero as neutral', () => {
      const qtyResult = SignedQuantityService.create(0);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toPnLString(qtyResult.value, 2);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe('0.00');
          expect(result.value.indicator).toBe('neutral');
        }
      }
    });

    it('should propagate error from toString for invalid decimals', () => {
      const qtyResult = SignedQuantityService.create(10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const result = SignedQuantityFormatter.toPnLString(qtyResult.value, -1);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.op).toContain('toString');
          expect(result.error.message).toContain('must be');
        }
      }
    });

    it('should use default decimals=2 when not provided', () => {
      const profitResult = SignedQuantityService.create(10.567);
      expect(profitResult.ok).toBe(true);
      if (profitResult.ok) {
        const result = SignedQuantityFormatter.toPnLString(profitResult.value);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe('+10.57');
          expect(result.value.indicator).toBe('profit');
        }
      }
    });
  });
});
