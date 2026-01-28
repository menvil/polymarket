import { describe, it, expect } from '@jest/globals';
import {
  addDecimal,
  multiplyDecimal,
  divideDecimal,
  roundToTick,
  roundToPrecision,
  equalsDecimal,
  MATH_CONSTANTS,
} from '../../src/index.js';
import Decimal from 'decimal.js';

describe('Operations Chain Integration', () => {
  describe('основные цепочки операций', () => {
    it('должен правильно выполнять цепочку (10 + 5) * 2 / 3', () => {
      const step1 = addDecimal(new Decimal(10), new Decimal(5)); // 15
      const step2 = multiplyDecimal(step1, new Decimal(2)); // 30
      const step3 = divideDecimal(step2, new Decimal(3)); // 10
      const result = roundToPrecision(step3, 2, Decimal.ROUND_HALF_UP); // 10.00

      expect(result.toString()).toBe('10');
    });

    it('должен корректно обрабатывать сложные вычисления', () => {
      // Вычисление средней цены: (price1 * qty1 + price2 * qty2) / (qty1 + qty2)
      const price1 = new Decimal(100);
      const qty1 = new Decimal(10);
      const price2 = new Decimal(120);
      const qty2 = new Decimal(15);

      const cost1 = multiplyDecimal(price1, qty1); // 1000
      const cost2 = multiplyDecimal(price2, qty2); // 1800
      const totalCost = addDecimal(cost1, cost2); // 2800
      const totalQty = addDecimal(qty1, qty2); // 25
      const avgPrice = divideDecimal(totalCost, totalQty); // 112

      expect(avgPrice.toString()).toBe('112');
    });

    it('должен работать с округлением в цепочке', () => {
      const value = new Decimal(10.567);
      const multiplied = multiplyDecimal(value, new Decimal(3)); // 31.701
      const rounded = roundToTick(
        multiplied,
        new Decimal(0.01),
        Decimal.ROUND_HALF_UP
      ); // 31.70

      expect(rounded.toString()).toBe('31.7');
    });
  });

  describe('использование констант', () => {
    it('использование ZERO', () => {
      const value = new Decimal(100);
      const result = addDecimal(value, MATH_CONSTANTS.ZERO);

      expect(result.toString()).toBe('100');
    });

    it('использование ONE', () => {
      const value = new Decimal(42);
      const result = multiplyDecimal(value, MATH_CONSTANTS.ONE);

      expect(result.toString()).toBe('42');
    });

    it('точное сравнение с equalsDecimal', () => {
      const a = new Decimal(10);
      const b = new Decimal(10);
      const c = new Decimal('10.0000000001');

      // Строгое равенство
      expect(equalsDecimal(a, b)).toBe(true);
      expect(equalsDecimal(a, c)).toBe(false); // Строго неравны
    });
  });

});
