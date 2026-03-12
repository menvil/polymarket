/**
 * Тесты TradeFlowCalculator.
 *
 * @remarks
 * Покрывает:
 * - compute([]) — пустой массив → нулевые метрики
 * - Один BUY трейд — buyVolume, OFI=+1, VWAP
 * - Один SELL трейд — sellVolume, OFI=-1, VWAP
 * - Несколько трейдов — VWAP, OFI
 * - Записи с side=undefined — учитываются в VWAP, не в OFI
 * - Типы Decimal в результате
 */
import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { TradeFlowCalculator } from '../../src/TradeFlowCalculator.js';
import type { TapeRecord } from '../../src/TapeRecord.js';
import { Price, Quantity, Timestamp } from '@polymarket/value-objects';

// ==================== Вспомогательные функции ====================

const BASE_TIME = 1_700_000_000_000;

function makeRecord(params: {
  price: number;
  size: number;
  side?: 'BUY' | 'SELL';
  timestampMs?: number;
}): TapeRecord {
  return {
    price: Price.of(new Decimal(params.price)),
    size: Quantity.of(new Decimal(params.size)),
    side: params.side,
    timestamp: Timestamp.of(new Decimal(params.timestampMs ?? BASE_TIME)),
  };
}

// ==================== Тесты ====================

describe('TradeFlowCalculator', () => {
  describe('compute() с пустым массивом', () => {
    it('возвращает нулевые Decimal метрики', () => {
      const metrics = TradeFlowCalculator.compute([]);

      expect(metrics.buyVolume.isZero()).toBe(true);
      expect(metrics.sellVolume.isZero()).toBe(true);
      expect(metrics.totalVolume.isZero()).toBe(true);
      expect(metrics.orderFlowImbalance.isZero()).toBe(true);
      expect(metrics.vwap).toBeUndefined();
      expect(metrics.totalNotional.isZero()).toBe(true);
      expect(metrics.tradeCount).toBe(0);
    });

    it('возвращает Decimal типы', () => {
      const metrics = TradeFlowCalculator.compute([]);
      expect(metrics.buyVolume).toBeInstanceOf(Decimal);
      expect(metrics.orderFlowImbalance).toBeInstanceOf(Decimal);
    });
  });

  describe('compute() с одним BUY трейдом', () => {
    it('вычисляет корректные метрики', () => {
      const record = makeRecord({ price: 0.6, size: 100, side: 'BUY' });
      const metrics = TradeFlowCalculator.compute([record]);

      expect(metrics.buyVolume.toNumber()).toBeCloseTo(100);
      expect(metrics.sellVolume.isZero()).toBe(true);
      expect(metrics.totalVolume.toNumber()).toBeCloseTo(100);
      expect(metrics.orderFlowImbalance.toNumber()).toBe(1); // только buy → max
      expect(metrics.vwap!.toNumber()).toBeCloseTo(0.6);
      expect(metrics.totalNotional.toNumber()).toBeCloseTo(60);
      expect(metrics.tradeCount).toBe(1);
    });
  });

  describe('compute() с одним SELL трейдом', () => {
    it('вычисляет корректные метрики', () => {
      const record = makeRecord({ price: 0.7, size: 200, side: 'SELL' });
      const metrics = TradeFlowCalculator.compute([record]);

      expect(metrics.buyVolume.isZero()).toBe(true);
      expect(metrics.sellVolume.toNumber()).toBeCloseTo(200);
      expect(metrics.totalVolume.toNumber()).toBeCloseTo(200);
      expect(metrics.orderFlowImbalance.toNumber()).toBe(-1); // только sell → min
      expect(metrics.vwap!.toNumber()).toBeCloseTo(0.7);
      expect(metrics.totalNotional.toNumber()).toBeCloseTo(140);
      expect(metrics.tradeCount).toBe(1);
    });
  });

  describe('compute() с несколькими трейдами', () => {
    it('вычисляет VWAP корректно', () => {
      // BUY 100 @ 0.6 + SELL 200 @ 0.8
      // totalNotional = 100*0.6 + 200*0.8 = 60 + 160 = 220
      // totalVolume = 300
      // VWAP = 220/300 ≈ 0.7333
      const records = [
        makeRecord({ price: 0.6, size: 100, side: 'BUY' }),
        makeRecord({ price: 0.8, size: 200, side: 'SELL' }),
      ];

      const metrics = TradeFlowCalculator.compute(records);
      expect(metrics.vwap!.toNumber()).toBeCloseTo(0.7333, 3);
      expect(metrics.totalNotional.toNumber()).toBeCloseTo(220);
      expect(metrics.totalVolume.toNumber()).toBeCloseTo(300);
      expect(metrics.tradeCount).toBe(2);
    });

    it('вычисляет OFI корректно', () => {
      // BUY 300 + SELL 100
      // OFI = (300 - 100) / (300 + 100) = 200/400 = 0.5
      const records = [
        makeRecord({ price: 0.65, size: 300, side: 'BUY' }),
        makeRecord({ price: 0.66, size: 100, side: 'SELL' }),
      ];

      const metrics = TradeFlowCalculator.compute(records);
      expect(metrics.orderFlowImbalance.toNumber()).toBeCloseTo(0.5);
    });

    it('вычисляет OFI = 0 при равных объёмах', () => {
      const records = [
        makeRecord({ price: 0.65, size: 200, side: 'BUY' }),
        makeRecord({ price: 0.65, size: 200, side: 'SELL' }),
      ];

      const metrics = TradeFlowCalculator.compute(records);
      expect(metrics.orderFlowImbalance.isZero()).toBe(true);
    });
  });

  describe('compute() с записями без side', () => {
    it('не учитывает в buy/sell volume, но учитывает в VWAP', () => {
      const records = [
        makeRecord({ price: 0.5, size: 100, side: undefined }),
        makeRecord({ price: 0.9, size: 100, side: 'BUY' }),
      ];

      const metrics = TradeFlowCalculator.compute(records);
      expect(metrics.buyVolume.toNumber()).toBeCloseTo(100);
      expect(metrics.sellVolume.isZero()).toBe(true);
      expect(metrics.totalVolume.toNumber()).toBeCloseTo(200);
      // VWAP = (100*0.5 + 100*0.9) / 200 = 140/200 = 0.7
      expect(metrics.vwap!.toNumber()).toBeCloseTo(0.7);
      // OFI: только BUY 100, нет SELL → OFI=1
      expect(metrics.orderFlowImbalance.toNumber()).toBe(1);
      expect(metrics.tradeCount).toBe(2);
    });

    it('OFI = 0 если все записи без стороны', () => {
      const records = [
        makeRecord({ price: 0.5, size: 100, side: undefined }),
        makeRecord({ price: 0.6, size: 200, side: undefined }),
      ];

      const metrics = TradeFlowCalculator.compute(records);
      expect(metrics.orderFlowImbalance.isZero()).toBe(true);
      expect(metrics.buyVolume.isZero()).toBe(true);
      expect(metrics.sellVolume.isZero()).toBe(true);
      // VWAP всё равно считается: (100*0.5 + 200*0.6) / 300 = 170/300 ≈ 0.567
      expect(metrics.vwap!.toNumber()).toBeCloseTo(0.5667, 3);
    });
  });
});
