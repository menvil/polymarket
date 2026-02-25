import { SignedQuantityFormatter } from '../../../src/signed-quantity/adapters/SignedQuantityFormatter.js';
import { SignedQuantityService } from '../../../src/signed-quantity/facade/SignedQuantityService.js';
import { isErr } from '@polymarket/result';

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
  });
});
