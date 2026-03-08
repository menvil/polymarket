/**
 * Тесты для getTotalValue и getTotalUnrealizedPnL
 *
 * @remarks
 * Покрывает:
 * - LONG/SHORT суммирование в getTotalValue
 * - Пропуск позиций без цены
 * - getTotalUnrealizedPnL с несколькими позициями и mixed sign
 * - Пустой набор позиций (Money(0) / SignedQuantity.ZERO)
 */

import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { getTotalValue, getTotalUnrealizedPnL } from '../../../src/services/PortfolioValuationService.js';
import type { IPosition } from '../../../src/Portfolio.js';
import { Price } from '@polymarket/value-objects';
import type { InstrumentId } from '@polymarket/ids';

// ==================== Хелперы ====================

function makeInstrumentId(raw: string): InstrumentId {
  return raw as InstrumentId;
}

/** Создаёт Price VO. n должен быть в диапазоне [0.0001, 0.9999]. */
function makePrice(n: number): Price {
  return Price.of(new Decimal(n));
}

function makePosition(
  id: string,
  side: 'LONG' | 'SHORT',
  quantity: number,
  avgPrice: number,
  pnl = 0
): IPosition {
  const instrumentId = makeInstrumentId(id);
  const pnlDecimal = new Decimal(pnl);
  return {
    instrumentId,
    quantity: { value: () => new Decimal(quantity) },
    side,
    averageEntryPrice: makePrice(avgPrice),
    isClosed: () => false,
    getUnrealizedPnL: () => ({ value: () => pnlDecimal }),
  };
}

const NO_PRICE = (_id: InstrumentId): Price | undefined => undefined;

// ==================== getTotalValue ====================

describe('getTotalValue()', () => {
  it('возвращает Money(0, USDC) для пустого набора позиций', () => {
    const result = getTotalValue([], NO_PRICE, 'USDC');
    expect(result.value().toNumber()).toBe(0);
  });

  it('суммирует LONG позиции (положительный вклад)', () => {
    const id1 = makeInstrumentId('inst-1');
    const id2 = makeInstrumentId('inst-2');

    const positions = [
      makePosition('inst-1', 'LONG', 100, 0.60),
      makePosition('inst-2', 'LONG', 50, 0.70),
    ];

    const getPrice = (id: InstrumentId) => {
      if (id === id1) return makePrice(0.80);
      if (id === id2) return makePrice(0.90);
      return undefined;
    };

    // LONG: quantity * price → 100*0.80 + 50*0.90 = 80 + 45 = 125
    const result = getTotalValue(positions, getPrice, 'USDC');
    expect(result.value().toNumber()).toBeCloseTo(125, 10);
  });

  it('вычитает SHORT позиции (отрицательный вклад)', () => {
    const id = makeInstrumentId('inst-short');
    const positions = [makePosition('inst-short', 'SHORT', 200, 0.50)];
    const getPrice = (i: InstrumentId) => (i === id ? makePrice(0.60) : undefined);

    // SHORT: -quantity * price → -200*0.60 = -120
    const result = getTotalValue(positions, getPrice, 'USDC');
    expect(result.value().toNumber()).toBeCloseTo(-120, 10);
  });

  it('корректно обрабатывает mixed LONG и SHORT', () => {
    const idL = makeInstrumentId('long-pos');
    const idS = makeInstrumentId('short-pos');

    const positions = [
      makePosition('long-pos', 'LONG', 100, 0.60),
      makePosition('short-pos', 'SHORT', 50, 0.70),
    ];

    const getPrice = (id: InstrumentId) => {
      if (id === idL) return makePrice(0.80);
      if (id === idS) return makePrice(0.90);
      return undefined;
    };

    // 100*0.80 - 50*0.90 = 80 - 45 = 35
    const result = getTotalValue(positions, getPrice, 'USDC');
    expect(result.value().toNumber()).toBeCloseTo(35, 10);
  });

  it('пропускает позиции без цены', () => {
    const idWithPrice = makeInstrumentId('with-price');
    const positions = [
      makePosition('with-price', 'LONG', 100, 0.60),
      makePosition('no-price', 'LONG', 200, 0.50),
    ];

    const getPrice = (id: InstrumentId) =>
      id === idWithPrice ? makePrice(0.80) : undefined;

    // Только первая позиция: 100*0.80 = 80
    const result = getTotalValue(positions, getPrice, 'USDC');
    expect(result.value().toNumber()).toBeCloseTo(80, 10);
  });
});

// ==================== getTotalUnrealizedPnL ====================

describe('getTotalUnrealizedPnL()', () => {
  it('возвращает SignedQuantity(0) для пустого набора позиций', () => {
    const result = getTotalUnrealizedPnL([], NO_PRICE);
    expect(result.value().toNumber()).toBe(0);
  });

  it('суммирует PnL нескольких позиций', () => {
    const id1 = makeInstrumentId('inst-1');
    const id2 = makeInstrumentId('inst-2');

    // pnl делегируется в position.getUnrealizedPnL(price)
    // Наш стаб возвращает фиксированный pnl независимо от переданной цены
    const positions = [
      makePosition('inst-1', 'LONG', 100, 0.60, 8.5),
      makePosition('inst-2', 'LONG', 50, 0.70, -3.0),
    ];

    const getPrice = (id: InstrumentId) => {
      if (id === id1) return makePrice(0.75);
      if (id === id2) return makePrice(0.64);
      return undefined;
    };

    // 8.5 + (-3.0) = 5.5
    const result = getTotalUnrealizedPnL(positions, getPrice);
    expect(result.value().toNumber()).toBeCloseTo(5.5, 10);
  });

  it('возвращает отрицательный PnL при убыточных позициях', () => {
    const id = makeInstrumentId('losing');
    const positions = [makePosition('losing', 'LONG', 100, 0.80, -15.0)];
    const getPrice = (i: InstrumentId) => (i === id ? makePrice(0.65) : undefined);

    const result = getTotalUnrealizedPnL(positions, getPrice);
    expect(result.value().toNumber()).toBeCloseTo(-15.0, 10);
  });

  it('пропускает позиции без цены', () => {
    const idWithPrice = makeInstrumentId('with-price');
    const positions = [
      makePosition('with-price', 'LONG', 100, 0.60, 10.0),
      makePosition('no-price', 'LONG', 50, 0.70, 99.0),
    ];

    const getPrice = (id: InstrumentId) =>
      id === idWithPrice ? makePrice(0.70) : undefined;

    // Только первая позиция: pnl = 10.0
    const result = getTotalUnrealizedPnL(positions, getPrice);
    expect(result.value().toNumber()).toBeCloseTo(10.0, 10);
  });
});
