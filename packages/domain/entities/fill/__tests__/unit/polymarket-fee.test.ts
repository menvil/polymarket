/**
 * Тесты для polymarket-fee.ts
 *
 * @remarks
 * Покрывает:
 * - calculatePolymarketTakerFee / calculatePolymarketTakerFeeWithRate (VO-based, Fee VO)
 * - calculatePolymarketTakerFeeNumber (примитивы, graceful zero на невалидном входе — не throw)
 * - Округление до 5 знаков и MIN_FEE_USDC threshold
 */
import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Price, Quantity } from '@polymarket/value-objects';
import {
  calculatePolymarketTakerFee,
  calculatePolymarketTakerFeeWithRate,
  calculatePolymarketTakerFeeNumber,
  POLYMARKET_CRYPTO_TAKER_FEE_RATE,
} from '../../src/polymarket-fee.js';

function qty(n: number): Quantity {
  return Quantity.of(new Decimal(n));
}

function price(n: number): Price {
  return Price.of(new Decimal(n));
}

describe('calculatePolymarketTakerFee()', () => {
  it('BUY 10 @ 0.50 → fee = 10 × 0.072 × 0.50 × 0.50 = 0.18', () => {
    const fee = calculatePolymarketTakerFee(qty(10), price(0.5));
    expect(fee.quantity.amount().value().toNumber()).toBeCloseTo(0.18, 5);
  });

  it('возвращает Fee VO с активом USDC', () => {
    const fee = calculatePolymarketTakerFee(qty(10), price(0.5));
    expect(fee.asset.type).toBe('CURRENCY');
    if (fee.asset.type === 'CURRENCY') {
      expect(fee.asset.currency).toBe('USDC');
    }
  });

  it('использует POLYMARKET_CRYPTO_TAKER_FEE_RATE по умолчанию', () => {
    const fee = calculatePolymarketTakerFee(qty(100), price(0.3));
    const expected = new Decimal(100)
      .mul(POLYMARKET_CRYPTO_TAKER_FEE_RATE)
      .mul(0.3)
      .mul(0.7)
      .toDecimalPlaces(5, Decimal.ROUND_HALF_UP);
    expect(fee.quantity.amount().value().toNumber()).toBeCloseTo(expected.toNumber(), 5);
  });
});

describe('calculatePolymarketTakerFeeWithRate()', () => {
  it('вычисляет комиссию с явной ставкой', () => {
    const fee = calculatePolymarketTakerFeeWithRate(qty(10), price(0.5), 0.05);
    // 10 × 0.05 × 0.5 × 0.5 = 0.125
    expect(fee.quantity.amount().value().toNumber()).toBeCloseTo(0.125, 5);
  });

  it('feeRate = 0 → Fee.zero (не throws)', () => {
    const fee = calculatePolymarketTakerFeeWithRate(qty(10), price(0.5), 0);
    expect(fee.isZero()).toBe(true);
  });

  it('feeRate отрицательный → Fee.zero', () => {
    const fee = calculatePolymarketTakerFeeWithRate(qty(10), price(0.5), -0.01);
    expect(fee.isZero()).toBe(true);
  });

  it('size = 0 → Fee.zero (Quantity допускает 0, формула не начисляет)', () => {
    const fee = calculatePolymarketTakerFeeWithRate(qty(0), price(0.5), POLYMARKET_CRYPTO_TAKER_FEE_RATE);
    expect(fee.isZero()).toBe(true);
  });

  it('округляет до 5 знаков после запятой (ROUND_HALF_UP)', () => {
    const fee = calculatePolymarketTakerFeeWithRate(qty(1), price(0.333333), 0.1);
    const raw = fee.quantity.amount().value();
    expect(raw.decimalPlaces()).toBeLessThanOrEqual(5);
  });

  it('комиссия < MIN_FEE_USDC (0.00001) округляется до нуля', () => {
    const fee = calculatePolymarketTakerFeeWithRate(qty(0.001), price(0.001), 0.001);
    expect(fee.isZero()).toBe(true);
  });

  it('принимает feeRate как Decimal', () => {
    const fee = calculatePolymarketTakerFeeWithRate(qty(10), price(0.5), new Decimal(0.05));
    expect(fee.quantity.amount().value().toNumber()).toBeCloseTo(0.125, 5);
  });
});

describe('calculatePolymarketTakerFeeNumber()', () => {
  it('вычисляет то же значение, что и VO-based версия', () => {
    const feeNumber = calculatePolymarketTakerFeeNumber(10, 0.5);
    const feeVO = calculatePolymarketTakerFee(qty(10), price(0.5));
    expect(feeNumber).toBeCloseTo(feeVO.quantity.amount().value().toNumber(), 5);
  });

  it('использует POLYMARKET_CRYPTO_TAKER_FEE_RATE по умолчанию', () => {
    expect(calculatePolymarketTakerFeeNumber(10, 0.5)).toBeCloseTo(0.18, 5);
  });

  it('принимает явную ставку', () => {
    expect(calculatePolymarketTakerFeeNumber(10, 0.5, 0.05)).toBeCloseTo(0.125, 5);
  });

  // Граница с VO: Price/Quantity бросают на невалидном значении (NaN/Infinity/вне диапазона),
  // но calculatePolymarketTakerFeeNumber должна сохранять старый контракт "невалидный вход →
  // тихо 0" — guard проверяется на сырых значениях ДО конструирования VO (см. TSDoc функции).
  describe('graceful zero на невалидном входе (не throw)', () => {
    it('size = NaN → 0', () => {
      expect(calculatePolymarketTakerFeeNumber(NaN, 0.5)).toBe(0);
    });

    it('price = NaN → 0', () => {
      expect(calculatePolymarketTakerFeeNumber(10, NaN)).toBe(0);
    });

    it('price = Infinity → 0 (вне диапазона Price VO)', () => {
      expect(calculatePolymarketTakerFeeNumber(10, Infinity)).toBe(0);
    });

    it('price = 0 → 0 (вне диапазона Price VO)', () => {
      expect(calculatePolymarketTakerFeeNumber(10, 0)).toBe(0);
    });

    it('price = 1 → 0 (вне диапазона Price VO, границы исключены)', () => {
      expect(calculatePolymarketTakerFeeNumber(10, 1)).toBe(0);
    });

    it('price < 0 → 0', () => {
      expect(calculatePolymarketTakerFeeNumber(10, -0.5)).toBe(0);
    });

    it('size = 0 → 0', () => {
      expect(calculatePolymarketTakerFeeNumber(0, 0.5)).toBe(0);
    });

    it('size < 0 → 0', () => {
      expect(calculatePolymarketTakerFeeNumber(-10, 0.5)).toBe(0);
    });

    it('feeRate = 0 → 0', () => {
      expect(calculatePolymarketTakerFeeNumber(10, 0.5, 0)).toBe(0);
    });

    it('ни одно сочетание невалидного входа не бросает исключение', () => {
      const invalidInputs: Array<[number, number, number?]> = [
        [NaN, 0.5],
        [10, NaN],
        [10, Infinity],
        [Infinity, 0.5],
        [10, -1],
        [-10, 0.5],
        [10, 0.5, NaN],
        [10, 0.5, -1],
      ];
      for (const [size, price, feeRate] of invalidInputs) {
        expect(() => calculatePolymarketTakerFeeNumber(size, price, feeRate)).not.toThrow();
      }
    });
  });
});
