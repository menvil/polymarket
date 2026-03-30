import { describe, it, expect } from '@jest/globals';
import { FeeCalculator } from '../src/FeeCalculator.js';
import { FEE_MODEL_CURRENT, FEE_MODEL_MARCH30 } from '../src/types.js';

describe('FeeCalculator', () => {
  describe('текущая модель (rate=0.25, exp=2)', () => {
    const calc = new FeeCalculator(FEE_MODEL_CURRENT);

    it('пиковая ставка при p=0.50 ≈ 1.56%', () => {
      const fee = calc.takerFee(0.50);
      // 0.50 × 0.25 × (0.50 × 0.50)^2 = 0.50 × 0.25 × 0.0625 = 0.0078125
      expect(fee).toBeCloseTo(0.0078125, 6);
      // Effective rate = fee / price = 0.0078125 / 0.50 ≈ 1.5625%
      expect(fee / 0.50).toBeCloseTo(0.015625, 4);
    });

    it('fee=0 при price=0', () => {
      expect(calc.takerFee(0)).toBe(0);
    });

    it('fee=0 при price=1', () => {
      expect(calc.takerFee(1)).toBe(0);
    });

    it('fee убывает к краям (p=0.10 < p=0.50)', () => {
      expect(calc.takerFee(0.10)).toBeLessThan(calc.takerFee(0.50));
    });

    it('fee симметричен: f(0.3) = f(0.7) × (0.3/0.7)', () => {
      // Не симметричен по абсолюту, но формула проверяема
      const f03 = calc.takerFee(0.30);
      const f07 = calc.takerFee(0.70);
      // f(p) = p × rate × (p(1-p))^exp
      // f(0.3) = 0.3 × 0.25 × (0.21)^2 = 0.003308
      expect(f03).toBeCloseTo(0.3 * 0.25 * Math.pow(0.3 * 0.7, 2), 6);
      expect(f07).toBeCloseTo(0.7 * 0.25 * Math.pow(0.7 * 0.3, 2), 6);
    });
  });

  describe('модель march30 (rate=0.072, exp=1)', () => {
    const calc = new FeeCalculator(FEE_MODEL_MARCH30);

    it('пиковая ставка при p=0.50 ≈ 1.80%', () => {
      const fee = calc.takerFee(0.50);
      // 0.50 × 0.072 × (0.25)^1 = 0.009
      expect(fee).toBeCloseTo(0.009, 6);
      // Effective rate = 0.009 / 0.50 = 1.80%
      expect(fee / 0.50).toBeCloseTo(0.018, 4);
    });
  });

  describe('pairFee', () => {
    const calc = new FeeCalculator(FEE_MODEL_CURRENT);

    it('maker + taker: fee только от taker-ноги', () => {
      const fee = calc.pairFee(0.45, true, 0.48, false);
      expect(fee).toBeCloseTo(calc.takerFee(0.45), 8);
    });

    it('оба taker: сумма обоих fee', () => {
      const fee = calc.pairFee(0.45, true, 0.48, true);
      expect(fee).toBeCloseTo(calc.takerFee(0.45) + calc.takerFee(0.48), 8);
    });

    it('оба maker: fee = 0', () => {
      expect(calc.pairFee(0.45, false, 0.48, false)).toBe(0);
    });
  });
});
