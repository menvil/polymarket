import { describe, it, expect } from '@jest/globals';
import { FeeCalculator } from '../src/FeeCalculator.js';
import { FEE_MODEL_CURRENT, FEE_MODEL_MARCH30 } from '../src/types.js';

describe('FeeCalculator', () => {
  describe('текущая crypto-модель (rate=0.072, exp=1)', () => {
    const calc = new FeeCalculator(FEE_MODEL_CURRENT);

    it('считает fee по формуле Polymarket для 1 share', () => {
      const fee = calc.takerFee(0.50);
      // 1 × 0.072 × 0.50 × 0.50 = 0.018
      expect(fee).toBeCloseTo(0.018, 6);
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

    it('fee симметричен по price: f(0.3) = f(0.7)', () => {
      const f03 = calc.takerFee(0.30);
      const f07 = calc.takerFee(0.70);
      expect(f03).toBeCloseTo(0.072 * 0.3 * 0.7, 6);
      expect(f07).toBeCloseTo(f03, 6);
    });

    it('поддерживает расчёт на полный size с round5', () => {
      const fee = calc.takerFee(0.65, 10);
      expect(fee).toBeCloseTo(0.1638, 6);
    });

    it('deprecated march30 alias совпадает с текущей моделью', () => {
      const aliasCalc = new FeeCalculator(FEE_MODEL_MARCH30);
      expect(aliasCalc.takerFee(0.50, 10)).toBe(calc.takerFee(0.50, 10));
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
