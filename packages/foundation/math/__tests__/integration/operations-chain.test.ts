import { describe, it, expect } from '@jest/globals';
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  roundToTick,
  roundToPrecision,
  MATH_CONSTANTS,
} from '../../src/index.js';
import Decimal from 'decimal.js';

describe('Operations Chain Integration', () => {
  describe('основные цепочки операций', () => {
    it('должен правильно выполнять цепочку (10 + 5) * 2 / 3', () => {
      const step1 = addDecimal(new Decimal(10), new Decimal(5)); // 15
      const step2 = multiplyDecimal(step1, new Decimal(2)); // 30
      const step3 = divideDecimal(step2, new Decimal(3)); // 10
      const result = roundToPrecision(step3, 2); // 10.00

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
      const rounded = roundToTick(multiplied, new Decimal(0.01)); // 31.70

      expect(rounded.toString()).toBe('31.7');
    });
  });

  describe('финансовые расчеты', () => {
    it('расчет PnL: (sellPrice - buyPrice) * quantity', () => {
      const buyPrice = new Decimal('0.65');
      const sellPrice = new Decimal('0.75');
      const quantity = new Decimal(1000);

      const priceDiff = subtractDecimal(sellPrice, buyPrice); // 0.10
      const pnl = multiplyDecimal(priceDiff, quantity); // 100

      expect(pnl.toString()).toBe('100');
    });

    it('расчет комиссии: amount * feeRate', () => {
      const amount = new Decimal(1000);
      const feeRate = new Decimal('0.02'); // 2%

      const fee = multiplyDecimal(amount, feeRate);
      const rounded = roundToPrecision(fee, 2);

      expect(rounded.toString()).toBe('20');
    });

    it('расчет нетто после комиссии', () => {
      const amount = new Decimal(1000);
      const feeRate = new Decimal('0.02');

      const fee = multiplyDecimal(amount, feeRate); // 20
      const net = subtractDecimal(amount, fee); // 980

      expect(net.toString()).toBe('980');
    });

    it('расчет маржи: (sell - cost) / sell * 100', () => {
      const sellPrice = new Decimal(150);
      const costPrice = new Decimal(100);
      const hundred = MATH_CONSTANTS.HUNDRED;

      const profit = subtractDecimal(sellPrice, costPrice); // 50
      const margin = divideDecimal(profit, sellPrice); // 0.333...
      const marginPercent = multiplyDecimal(margin, hundred); // 33.33...
      const rounded = roundToPrecision(marginPercent, 2); // 33.33

      expect(rounded.toString()).toBe('33.33');
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

    it('использование DEFAULT_TICK для округления', () => {
      const value = new Decimal('10.567');
      const rounded = roundToTick(value, MATH_CONSTANTS.DEFAULT_TICK);

      expect(rounded.toString()).toBe('10.57');
    });

    it('использование DEFAULT_EPSILON для сравнения', () => {
      const a = new Decimal(10);
      const b = new Decimal('10.00000000001'); // Разница 1e-11, меньше epsilon 1e-10
      const epsilon = MATH_CONSTANTS.DEFAULT_EPSILON;

      const diff = subtractDecimal(a, b).abs();
      const isEqual = diff.lessThan(epsilon);

      expect(isEqual).toBe(true);
    });
  });

  describe('сложные сценарии', () => {
    it('составной расчет с несколькими округлениями', () => {
      // Сценарий: Купил 100 акций по $50.567, продал 60 по $55.123
      const buyPrice = new Decimal('50.567');
      const sellPrice = new Decimal('55.123');
      const sellQty = new Decimal(60);

      // Округляем цены до центов
      const buyPriceRounded = roundToTick(buyPrice, new Decimal(0.01));
      const sellPriceRounded = roundToTick(sellPrice, new Decimal(0.01));

      // Расчет PnL на проданную часть
      const buyTotal = multiplyDecimal(buyPriceRounded, sellQty);
      const sellTotal = multiplyDecimal(sellPriceRounded, sellQty);
      const pnl = subtractDecimal(sellTotal, buyTotal);

      // Округляем финальный результат
      const pnlRounded = roundToPrecision(pnl, 2);

      expect(buyPriceRounded.toString()).toBe('50.57');
      expect(sellPriceRounded.toString()).toBe('55.12');
      expect(pnlRounded.toString()).toBe('273');
    });

    it('weighted average с округлением', () => {
      // Три покупки по разным ценам
      const purchases = [
        { price: new Decimal('100.50'), qty: new Decimal(10) },
        { price: new Decimal('102.75'), qty: new Decimal(15) },
        { price: new Decimal('99.25'), qty: new Decimal(5) },
      ];

      let totalCost = MATH_CONSTANTS.ZERO;
      let totalQty = MATH_CONSTANTS.ZERO;

      for (const p of purchases) {
        const cost = multiplyDecimal(p.price, p.qty);
        totalCost = addDecimal(totalCost, cost);
        totalQty = addDecimal(totalQty, p.qty);
      }

      const avgPrice = divideDecimal(totalCost, totalQty);
      const rounded = roundToPrecision(avgPrice, 2);

      // (1005 + 1541.25 + 496.25) / 30 = 3042.5 / 30 = 101.4166... ≈ 101.42
      expect(rounded.toString()).toBe('101.42');
    });
  });

  describe('обработка граничных случаев', () => {
    it('деление с последующим округлением не теряет точность', () => {
      const a = new Decimal(10);
      const b = new Decimal(3);

      const divided = divideDecimal(a, b);
      const rounded = roundToPrecision(divided, 10);

      expect(rounded.toString()).toBe('3.3333333333');
    });

    it('множественные операции с очень маленькими числами', () => {
      const tiny = new Decimal('1e-8');
      const result = multiplyDecimal(tiny, new Decimal(2));
      const result2 = addDecimal(result, new Decimal('1e-8'));

      expect(result2.toString()).toBe('3e-8');
    });
  });
});
