import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { TradeFlowCalculator } from '../../src/TradeFlowCalculator.js';
import { Trade } from '@polymarket/trade';
import { AssetIdHelpers, asVenueTradeId, KnownVenues } from '@polymarket/ids';
import { Price, Quantity, Timestamp } from '@polymarket/value-objects';

// ==================== Вспомогательные функции ====================

let tradeCounter = 0;

function makeTrade(params: {
  price: number;
  size: number;
  side?: 'BUY' | 'SELL';
  timestampMs?: number;
}): Trade {
  tradeCounter++;
  const result = Trade.create({
    id: asVenueTradeId(`trade-${tradeCounter}-${Date.now()}`)!,
    venueId: KnownVenues.POLYMARKET,
    marketId: 'market-test',
    tokenId: AssetIdHelpers.USDC,
    price: Price.of(new Decimal(params.price)),
    size: Quantity.of(new Decimal(params.size)),
    aggressorSide: params.side,
    timestamp: Timestamp.of(new Decimal(params.timestampMs ?? 1700000000000)),
  });

  if (!result.ok) throw new Error(`Failed to create trade: ${result.error.message}`);
  return result.value;
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
      const trade = makeTrade({ price: 0.6, size: 100, side: 'BUY' });
      const metrics = TradeFlowCalculator.compute([trade]);

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
      const trade = makeTrade({ price: 0.7, size: 200, side: 'SELL' });
      const metrics = TradeFlowCalculator.compute([trade]);

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
      const trades = [
        makeTrade({ price: 0.6, size: 100, side: 'BUY' }),
        makeTrade({ price: 0.8, size: 200, side: 'SELL' }),
      ];

      const metrics = TradeFlowCalculator.compute(trades);
      expect(metrics.vwap!.toNumber()).toBeCloseTo(0.7333, 3);
      expect(metrics.totalNotional.toNumber()).toBeCloseTo(220);
      expect(metrics.totalVolume.toNumber()).toBeCloseTo(300);
      expect(metrics.tradeCount).toBe(2);
    });

    it('вычисляет OFI корректно', () => {
      // BUY 300 + SELL 100
      // OFI = (300 - 100) / (300 + 100) = 200/400 = 0.5
      const trades = [
        makeTrade({ price: 0.65, size: 300, side: 'BUY' }),
        makeTrade({ price: 0.66, size: 100, side: 'SELL' }),
      ];

      const metrics = TradeFlowCalculator.compute(trades);
      expect(metrics.orderFlowImbalance.toNumber()).toBeCloseTo(0.5);
    });

    it('вычисляет OFI = 0 при равных объёмах', () => {
      const trades = [
        makeTrade({ price: 0.65, size: 200, side: 'BUY' }),
        makeTrade({ price: 0.65, size: 200, side: 'SELL' }),
      ];

      const metrics = TradeFlowCalculator.compute(trades);
      expect(metrics.orderFlowImbalance.isZero()).toBe(true);
    });
  });

  describe('compute() с трейдами без aggressorSide', () => {
    it('не учитывает в buy/sell volume, но учитывает в VWAP', () => {
      const trades = [
        makeTrade({ price: 0.5, size: 100, side: undefined }),
        makeTrade({ price: 0.9, size: 100, side: 'BUY' }),
      ];

      const metrics = TradeFlowCalculator.compute(trades);
      expect(metrics.buyVolume.toNumber()).toBeCloseTo(100);
      expect(metrics.sellVolume.isZero()).toBe(true);
      expect(metrics.totalVolume.toNumber()).toBeCloseTo(200);
      expect(metrics.vwap!.toNumber()).toBeCloseTo(0.7);
      expect(metrics.orderFlowImbalance.toNumber()).toBe(1);
      expect(metrics.tradeCount).toBe(2);
    });

    it('OFI = 0 если все трейды без стороны', () => {
      const trades = [
        makeTrade({ price: 0.5, size: 100, side: undefined }),
        makeTrade({ price: 0.6, size: 200, side: undefined }),
      ];

      const metrics = TradeFlowCalculator.compute(trades);
      expect(metrics.orderFlowImbalance.isZero()).toBe(true);
      expect(metrics.buyVolume.isZero()).toBe(true);
      expect(metrics.sellVolume.isZero()).toBe(true);
    });
  });
});
