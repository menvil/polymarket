import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { OutcomePriceFormatter } from '../../../../src/outcome-price/adapters/OutcomePriceFormatter.js';
import { OutcomePrice } from '../../../../src/outcome-price/core/OutcomePrice.js';
import { Result } from '@polymarket/result';

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`Expected Ok but got Err: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('OutcomePriceFormatter', () => {
  describe('toPercentage()', () => {
    it('должен форматировать как процент с 2 знаками по умолчанию', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      expect(unwrap(OutcomePriceFormatter.toPercentage(price))).toBe('50.00%');
    });

    it('должен форматировать с указанным количеством знаков', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      expect(unwrap(OutcomePriceFormatter.toPercentage(price, 0))).toBe('50%');
      expect(unwrap(OutcomePriceFormatter.toPercentage(price, 1))).toBe('50.0%');
      expect(unwrap(OutcomePriceFormatter.toPercentage(price, 4))).toBe('50.0000%');
    });

    it('должен корректно форматировать дробные значения', () => {
      const price = OutcomePrice.of(new Decimal(0.6789));
      expect(unwrap(OutcomePriceFormatter.toPercentage(price))).toBe('67.89%');
      expect(unwrap(OutcomePriceFormatter.toPercentage(price, 1))).toBe('67.9%');
      expect(unwrap(OutcomePriceFormatter.toPercentage(price, 3))).toBe('67.890%');
    });

    it('должен работать с минимальным значением', () => {
      const price = OutcomePrice.MIN;
      expect(unwrap(OutcomePriceFormatter.toPercentage(price))).toBe('0.01%');
    });

    it('должен работать с максимальным значением', () => {
      const price = OutcomePrice.MAX;
      expect(unwrap(OutcomePriceFormatter.toPercentage(price))).toBe('99.99%');
    });

    it('должен вернуть Err для отрицательного decimals', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceFormatter.toPercentage(price, -1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });

    it('должен вернуть Err для нецелого decimals', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceFormatter.toPercentage(price, 2.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });
  });

  describe('toFixed()', () => {
    it('должен форматировать с 4 знаками по умолчанию', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      expect(unwrap(OutcomePriceFormatter.toFixed(price))).toBe('0.5000');
    });

    it('должен форматировать с указанным количеством знаков', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      // Decimal.toFixed uses ROUND_HALF_UP rounding mode, so 0.5 rounds up to '1'
      expect(unwrap(OutcomePriceFormatter.toFixed(price, 0))).toBe('1');
      expect(unwrap(OutcomePriceFormatter.toFixed(price, 1))).toBe('0.5');
      expect(unwrap(OutcomePriceFormatter.toFixed(price, 2))).toBe('0.50');
      expect(unwrap(OutcomePriceFormatter.toFixed(price, 6))).toBe('0.500000');
    });

    it('должен вернуть Err для отрицательного decimals', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceFormatter.toFixed(price, -1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });

    it('должен вернуть Err для нецелого decimals', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceFormatter.toFixed(price, 2.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });

    it('должен корректно форматировать дробные значения', () => {
      const price = OutcomePrice.of(new Decimal(0.123456));
      expect(unwrap(OutcomePriceFormatter.toFixed(price, 2))).toBe('0.12');
      expect(unwrap(OutcomePriceFormatter.toFixed(price, 4))).toBe('0.1235');
      expect(unwrap(OutcomePriceFormatter.toFixed(price, 6))).toBe('0.123456');
    });

    it('должен работать с минимальным значением', () => {
      const price = OutcomePrice.MIN;
      expect(unwrap(OutcomePriceFormatter.toFixed(price, 4))).toBe('0.0001');
    });

    it('должен работать с максимальным значением', () => {
      const price = OutcomePrice.MAX;
      expect(unwrap(OutcomePriceFormatter.toFixed(price, 4))).toBe('0.9999');
    });
  });
});
