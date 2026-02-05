import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { PriceFormatter } from '../../../../src/price/adapters/PriceFormatter.js';
import { Price } from '../../../../src/price/core/Price.js';

describe('PriceFormatter', () => {
  describe('toPercentage()', () => {
    it('должен форматировать как процент с 2 знаками по умолчанию', () => {
      const price = Price.of(new Decimal(0.5));
      expect(PriceFormatter.toPercentage(price)).toBe('50.00%');
    });

    it('должен форматировать с указанным количеством знаков', () => {
      const price = Price.of(new Decimal(0.5));
      expect(PriceFormatter.toPercentage(price, 0)).toBe('50%');
      expect(PriceFormatter.toPercentage(price, 1)).toBe('50.0%');
      expect(PriceFormatter.toPercentage(price, 4)).toBe('50.0000%');
    });

    it('должен корректно форматировать дробные значения', () => {
      const price = Price.of(new Decimal(0.6789));
      expect(PriceFormatter.toPercentage(price)).toBe('67.89%');
      expect(PriceFormatter.toPercentage(price, 1)).toBe('67.9%');
      expect(PriceFormatter.toPercentage(price, 3)).toBe('67.890%');
    });

    it('должен работать с минимальным значением', () => {
      const price = Price.MIN;
      expect(PriceFormatter.toPercentage(price)).toBe('0.01%');
    });

    it('должен работать с максимальным значением', () => {
      const price = Price.MAX;
      expect(PriceFormatter.toPercentage(price)).toBe('99.99%');
    });
  });

  describe('toFixed()', () => {
    it('должен форматировать с 4 знаками по умолчанию', () => {
      const price = Price.of(new Decimal(0.5));
      expect(PriceFormatter.toFixed(price)).toBe('0.5000');
    });

    it('должен форматировать с указанным количеством знаков', () => {
      const price = Price.of(new Decimal(0.5));
      // Decimal.toFixed uses ROUND_HALF_UP rounding mode, so 0.5 rounds up to '1'
      expect(PriceFormatter.toFixed(price, 0)).toBe('1');
      expect(PriceFormatter.toFixed(price, 1)).toBe('0.5');
      expect(PriceFormatter.toFixed(price, 2)).toBe('0.50');
      expect(PriceFormatter.toFixed(price, 6)).toBe('0.500000');
    });

    it('должен бросить RangeError для отрицательного decimals', () => {
      const price = Price.of(new Decimal(0.5));
      expect(() => PriceFormatter.toFixed(price, -1)).toThrow(RangeError);
    });

    it('должен бросить RangeError для нецелого decimals', () => {
      const price = Price.of(new Decimal(0.5));
      expect(() => PriceFormatter.toFixed(price, 2.5)).toThrow(RangeError);
    });

    it('должен корректно форматировать дробные значения', () => {
      const price = Price.of(new Decimal(0.123456));
      expect(PriceFormatter.toFixed(price, 2)).toBe('0.12');
      expect(PriceFormatter.toFixed(price, 4)).toBe('0.1235');
      expect(PriceFormatter.toFixed(price, 6)).toBe('0.123456');
    });

    it('должен работать с минимальным значением', () => {
      const price = Price.MIN;
      expect(PriceFormatter.toFixed(price, 4)).toBe('0.0001');
    });

    it('должен работать с максимальным значением', () => {
      const price = Price.MAX;
      expect(PriceFormatter.toFixed(price, 4)).toBe('0.9999');
    });
  });
});
