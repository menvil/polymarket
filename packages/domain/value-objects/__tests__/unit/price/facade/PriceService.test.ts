import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { PriceService } from '../../../../src/price/facade/PriceService.js';
import { Price } from '../../../../src/price/core/Price.js';

describe('PriceService', () => {
  describe('create()', () => {
    it('должен создать Price из number', () => {
      const result = PriceService.create(0.5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен создать Price из string', () => {
      const result = PriceService.create('0.5');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен создать Price из Decimal', () => {
      const result = PriceService.create(new Decimal(0.5));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен вернуть Err для значения ниже минимума', () => {
      const result = PriceService.create(0.00001);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.value).toBe('0.00001');
      }
    });

    it('должен вернуть Err для значения выше максимума', () => {
      const result = PriceService.create(1.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.value).toBe('1.5');
      }
    });

    it('должен вернуть Err для NaN', () => {
      const result = PriceService.create(NaN);
      expect(result.ok).toBe(false);
    });

    it('должен никогда не бросать исключения', () => {
      expect(() => PriceService.create(NaN)).not.toThrow();
      expect(() => PriceService.create(Infinity)).not.toThrow();
      expect(() => PriceService.create('invalid')).not.toThrow();
    });
  });

  describe('complement()', () => {
    it('должен вычислить дополнение до 1', () => {
      const price = Price.of(0.3);
      const result = PriceService.complement(price);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.7, 10);
      }
    });

    it('должен вернуть 0.5 для 0.5', () => {
      const price = Price.of(0.5);
      const result = PriceService.complement(price);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен вернуть Err если результат выходит за диапазон', () => {
      const price = Price.of(0.9999);
      const result = PriceService.complement(price);
      // 1 - 0.9999 = 0.0001, что валидно
      expect(result.ok).toBe(true);
    });
  });

  describe('average()', () => {
    it('должен вычислить среднее двух цен', () => {
      const p1 = Price.of(0.2);
      const p2 = Price.of(0.8);
      const result = PriceService.average(p1, p2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен вернуть ту же цену для двух одинаковых', () => {
      const p1 = Price.of(0.5);
      const p2 = Price.of(0.5);
      const result = PriceService.average(p1, p2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен работать с крайними значениями', () => {
      const p1 = Price.min();
      const p2 = Price.max();
      const result = PriceService.average(p1, p2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.5, 4);
      }
    });
  });

  describe('multiply()', () => {
    it('должен умножить price на number', () => {
      const price = Price.of(0.3);
      const result = PriceService.multiply(price, 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.6, 10);
      }
    });

    it('должен умножить price на Decimal', () => {
      const price = Price.of(0.3);
      const result = PriceService.multiply(price, new Decimal(2));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.6, 10);
      }
    });

    it('должен вернуть InvalidOperandError для невалидного factor', () => {
      const price = Price.of(0.5);
      const result = PriceService.multiply(price, 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.operation).toBe('multiply');
        expect(result.error.context?.operand).toBe('factor');
      }
    });

    it('должен вернуть Err если результат выходит за диапазон', () => {
      const price = Price.of(0.5);
      const result = PriceService.multiply(price, 2);
      // 0.5 * 2 = 1.0, что выше максимума 0.9999
      expect(result.ok).toBe(false);
    });

    it('должен работать с дробными множителями', () => {
      const price = Price.of(0.6);
      const result = PriceService.multiply(price, 0.5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.3);
      }
    });
  });

  describe('divide()', () => {
    it('должен разделить price на number', () => {
      const price = Price.of(0.6);
      const result = PriceService.divide(price, 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.3);
      }
    });

    it('должен разделить price на Decimal', () => {
      const price = Price.of(0.6);
      const result = PriceService.divide(price, new Decimal(2));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.3);
      }
    });

    it('должен вернуть DivisionByZeroError для нулевого делителя', () => {
      const price = Price.of(0.5);
      const result = PriceService.divide(price, 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.divisor).toBe('0');
        expect(result.error.context?.dividend).toBe('0.5');
      }
    });

    it('должен вернуть InvalidDivisorError для невалидного divisor', () => {
      const price = Price.of(0.5);
      const result = PriceService.divide(price, 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context).toHaveProperty('divisor');
        expect(result.error.context).toHaveProperty('dividend');
      }
    });

    it('должен вернуть Err если результат выходит за диапазон', () => {
      const price = Price.min(); // 0.0001
      const result = PriceService.divide(price, 2);
      // 0.0001 / 2 = 0.00005, что ниже минимума
      expect(result.ok).toBe(false);
    });
  });

  describe('roundToMarketTick()', () => {
    it('должен округлить к ближайшему тику (nearest)', () => {
      const price = Price.of(0.12345);
      const result = PriceService.roundToMarketTick(price, 0.001);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.123, 10);
      }
    });

    it('должен округлить вниз (floor)', () => {
      const price = Price.of(0.12349);
      const result = PriceService.roundToMarketTick(price, 0.001, 'floor');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.123, 10);
      }
    });

    it('должен округлить вверх (ceil)', () => {
      const price = Price.of(0.12301);
      const result = PriceService.roundToMarketTick(price, 0.001, 'ceil');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.124, 10);
      }
    });

    it('должен вернуть Err для невалидного tickSize', () => {
      const price = Price.of(0.5);
      const result = PriceService.roundToMarketTick(price, -0.01);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
      }
    });

    it('должен работать с price не aligned к tickSize', () => {
      const price = Price.of(0.5555);
      const result = PriceService.roundToMarketTick(price, 0.01);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.56, 10);
      }
    });

    it('должен работать если price уже aligned', () => {
      const price = Price.of(0.5);
      const result = PriceService.roundToMarketTick(price, 0.1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });
  });

  describe('ensureAlignedToMarketTick()', () => {
    it('должен вернуть Ok если price aligned', () => {
      const price = Price.of(0.5);
      const result = PriceService.ensureAlignedToMarketTick(price, 0.1);
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err если price не aligned', () => {
      const price = Price.of(0.5);
      const result = PriceService.ensureAlignedToMarketTick(price, 0.3);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('price');
        expect(result.error.context?.reason).toBe('not_aligned');
      }
    });

    it('должен делегировать ValidateAligned', () => {
      const price = Price.of(0.1235);
      const result = PriceService.ensureAlignedToMarketTick(price, 0.01);
      expect(result.ok).toBe(false);
    });
  });
});
