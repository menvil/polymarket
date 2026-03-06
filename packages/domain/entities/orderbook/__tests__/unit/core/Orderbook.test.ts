/**
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import { Orderbook } from '../../../src/core/Orderbook.js';
import { OrderbookNormalizer } from '../../../src/normalizer/OrderbookNormalizer.js';
import { OrderbookInvalidReason } from '@polymarket/errors/orderbook';
import type { RawOrderbook } from '../../../src/normalizer/types.js';
import type { InstrumentId } from '@polymarket/ids';

describe('Orderbook', () => {
  const createTestOrderbook = (rawData: Partial<RawOrderbook> = {}) => {
    const raw: RawOrderbook = {
      marketId: 'market-123',
      tokenId: 'token-yes',
      bids: [
        { price: 0.52, quantity: 100 },
        { price: 0.51, quantity: 200 },
      ],
      asks: [
        { price: 0.53, quantity: 150 },
        { price: 0.54, quantity: 250 },
      ],
      ...rawData,
    };

    const normalized = OrderbookNormalizer.normalize(raw);
    if (!normalized.ok) {
      throw new Error('Failed to normalize test orderbook');
    }
    return Orderbook.fromNormalized(normalized.value);
  };

  describe('fromNormalized()', () => {
    it('создаёт Orderbook из нормализованных данных', () => {
      const orderbook = createTestOrderbook();

      expect(orderbook.instrumentId).toBe('market-123');
      expect(orderbook.asset).toBe('token-yes');
      expect(orderbook.bids.length).toBe(2);
      expect(orderbook.asks.length).toBe(2);
    });

    it('возвращает frozen объект', () => {
      const orderbook = createTestOrderbook();

      expect(Object.isFrozen(orderbook)).toBe(true);
    });

    it('сохраняет timestamps', () => {
      const venueTimestamp = Date.now() - 1000;
      const receivedAt = Date.now();

      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [],
        asks: [],
        venueTimestamp,
        receivedAt,
      };

      const normalized = OrderbookNormalizer.normalize(raw);
      if (!normalized.ok) throw new Error('Failed to normalize');
      const orderbook = Orderbook.fromNormalized(normalized.value);

      expect(orderbook.venueTimestamp?.toNumber()).toBe(venueTimestamp);
      expect(orderbook.receivedAt.toNumber()).toBe(receivedAt);
    });
  });

  describe('empty()', () => {
    it('создаёт пустой orderbook', () => {
      const orderbook = Orderbook.empty('market-123' as InstrumentId, 'token-yes' as InstrumentId);

      expect(orderbook.isEmpty()).toBe(true);
      expect(orderbook.bids.length).toBe(0);
      expect(orderbook.asks.length).toBe(0);
    });
  });

  describe('getBestBid()', () => {
    it('возвращает лучший bid (максимальная цена)', () => {
      const orderbook = createTestOrderbook();

      const bestBid = orderbook.getBestBid();

      expect(bestBid).not.toBeNull();
      expect(bestBid!.value().toNumber()).toBe(0.52);
    });

    it('возвращает null если нет бидов', () => {
      const orderbook = createTestOrderbook({ bids: [] });

      const bestBid = orderbook.getBestBid();

      expect(bestBid).toBeNull();
    });
  });

  describe('getBestAsk()', () => {
    it('возвращает лучший ask (минимальная цена)', () => {
      const orderbook = createTestOrderbook();

      const bestAsk = orderbook.getBestAsk();

      expect(bestAsk).not.toBeNull();
      expect(bestAsk!.value().toNumber()).toBe(0.53);
    });

    it('возвращает null если нет асков', () => {
      const orderbook = createTestOrderbook({ asks: [] });

      const bestAsk = orderbook.getBestAsk();

      expect(bestAsk).toBeNull();
    });
  });

  describe('getSpread()', () => {
    it('возвращает Ok(Spread) для валидного orderbook', () => {
      const orderbook = createTestOrderbook();

      const spreadResult = orderbook.getSpread();

      expect(spreadResult.ok).toBe(true);
      if (spreadResult.ok) {
        expect(spreadResult.value.width().toNumber()).toBe(0.01); // 0.53 - 0.52
      }
    });

    it('возвращает Err(EMPTY_BOOK) для пустого orderbook', () => {
      const orderbook = createTestOrderbook({ bids: [], asks: [] });

      const spreadResult = orderbook.getSpread();

      expect(spreadResult.ok).toBe(false);
      if (!spreadResult.ok) {
        expect(spreadResult.error.getReason()).toBe(OrderbookInvalidReason.EMPTY_BOOK);
      }
    });

    it('возвращает Err(ONE_SIDED) если есть только bids', () => {
      const orderbook = createTestOrderbook({ asks: [] });

      const spreadResult = orderbook.getSpread();

      expect(spreadResult.ok).toBe(false);
      if (!spreadResult.ok) {
        expect(spreadResult.error.getReason()).toBe(OrderbookInvalidReason.ONE_SIDED);
      }
    });

    it('возвращает Err(ONE_SIDED) если есть только asks', () => {
      const orderbook = createTestOrderbook({ bids: [] });

      const spreadResult = orderbook.getSpread();

      expect(spreadResult.ok).toBe(false);
      if (!spreadResult.ok) {
        expect(spreadResult.error.getReason()).toBe(OrderbookInvalidReason.ONE_SIDED);
      }
    });
  });

  describe('getMidPrice()', () => {
    it('возвращает mid price', () => {
      const orderbook = createTestOrderbook();

      const midPrice = orderbook.getMidPrice();

      expect(midPrice).not.toBeNull();
      expect(midPrice!.value().toNumber()).toBe(0.525); // (0.52 + 0.53) / 2
    });

    it('возвращает null если нет spread', () => {
      const orderbook = createTestOrderbook({ bids: [] });

      const midPrice = orderbook.getMidPrice();

      expect(midPrice).toBeNull();
    });
  });

  describe('getMicroprice()', () => {
    it('вычисляет microprice с учётом объёмов', () => {
      const orderbook = createTestOrderbook({
        bids: [{ price: 0.50, quantity: 100 }],
        asks: [{ price: 0.52, quantity: 200 }],
      });

      const microprice = orderbook.getMicroprice();

      expect(microprice).not.toBeNull();
      // microprice = (0.52 * 100 + 0.50 * 200) / (100 + 200)
      //            = (52 + 100) / 300 = 0.5067
      expect(microprice!.value().toNumber()).toBeCloseTo(0.5067, 4);
    });

    it('возвращает null если нет bid или ask', () => {
      const orderbook = createTestOrderbook({ bids: [] });

      const microprice = orderbook.getMicroprice();

      expect(microprice).toBeNull();
    });

    it('возвращает null если сумма qty = 0', () => {
      const orderbook = createTestOrderbook({
        bids: [{ price: 0.52, quantity: 0 }],
        asks: [{ price: 0.53, quantity: 0 }],
      });

      const microprice = orderbook.getMicroprice();

      expect(microprice).toBeNull();
    });
  });

  describe('getTotalBidVolume()', () => {
    it('вычисляет общий объём бидов', () => {
      const orderbook = createTestOrderbook();

      const totalVolume = orderbook.getTotalBidVolume();

      expect(totalVolume.value().toNumber()).toBe(300); // 100 + 200
    });

    it('вычисляет объём топ N уровней', () => {
      const orderbook = createTestOrderbook();

      const totalVolume = orderbook.getTotalBidVolume(1);

      expect(totalVolume.value().toNumber()).toBe(100); // только первый уровень
    });

    it('возвращает zero для пустого orderbook', () => {
      const orderbook = createTestOrderbook({ bids: [] });

      const totalVolume = orderbook.getTotalBidVolume();

      expect(totalVolume.isZero()).toBe(true);
    });
  });

  describe('getTotalAskVolume()', () => {
    it('вычисляет общий объём асков', () => {
      const orderbook = createTestOrderbook();

      const totalVolume = orderbook.getTotalAskVolume();

      expect(totalVolume.value().toNumber()).toBe(400); // 150 + 250
    });

    it('вычисляет объём топ N уровней', () => {
      const orderbook = createTestOrderbook();

      const totalVolume = orderbook.getTotalAskVolume(1);

      expect(totalVolume.value().toNumber()).toBe(150); // только первый уровень
    });

    it('возвращает zero для пустого orderbook', () => {
      const orderbook = createTestOrderbook({ asks: [] });

      const totalVolume = orderbook.getTotalAskVolume();

      expect(totalVolume.isZero()).toBe(true);
    });
  });

  describe('getImbalance()', () => {
    it('вычисляет imbalance', () => {
      const orderbook = createTestOrderbook({
        bids: [{ price: 0.52, quantity: 200 }],
        asks: [{ price: 0.53, quantity: 100 }],
      });

      const imbalance = orderbook.getImbalance();

      // imbalance = (200 - 100) / (200 + 100) = 100 / 300 = 0.333
      expect(imbalance).toBeCloseTo(0.333, 3);
    });

    it('возвращает 0 для сбалансированного orderbook', () => {
      const orderbook = createTestOrderbook({
        bids: [{ price: 0.52, quantity: 150 }],
        asks: [{ price: 0.53, quantity: 150 }],
      });

      const imbalance = orderbook.getImbalance();

      expect(imbalance).toBe(0);
    });

    it('возвращает 0 для пустого orderbook', () => {
      const orderbook = createTestOrderbook({ bids: [], asks: [] });

      const imbalance = orderbook.getImbalance();

      expect(imbalance).toBe(0);
    });

    it('возвращает отрицательное значение при преобладании asks', () => {
      const orderbook = createTestOrderbook({
        bids: [{ price: 0.52, quantity: 100 }],
        asks: [{ price: 0.53, quantity: 200 }],
      });

      const imbalance = orderbook.getImbalance();

      // imbalance = (100 - 200) / (100 + 200) = -100 / 300 = -0.333
      expect(imbalance).toBeCloseTo(-0.333, 3);
    });
  });

  describe('isEmpty()', () => {
    it('возвращает true для пустого orderbook', () => {
      const orderbook = createTestOrderbook({ bids: [], asks: [] });

      expect(orderbook.isEmpty()).toBe(true);
    });

    it('возвращает false для непустого orderbook', () => {
      const orderbook = createTestOrderbook();

      expect(orderbook.isEmpty()).toBe(false);
    });
  });

  describe('hasLiquidity()', () => {
    it('возвращает true если есть bid и ask', () => {
      const orderbook = createTestOrderbook();

      expect(orderbook.hasLiquidity()).toBe(true);
    });

    it('возвращает false если нет bid', () => {
      const orderbook = createTestOrderbook({ bids: [] });

      expect(orderbook.hasLiquidity()).toBe(false);
    });

    it('возвращает false если нет ask', () => {
      const orderbook = createTestOrderbook({ asks: [] });

      expect(orderbook.hasLiquidity()).toBe(false);
    });
  });

  describe('getBidDepth() / getAskDepth()', () => {
    it('возвращает количество уровней', () => {
      const orderbook = createTestOrderbook();

      expect(orderbook.getBidDepth()).toBe(2);
      expect(orderbook.getAskDepth()).toBe(2);
    });
  });

  describe('getAgeMs()', () => {
    it('вычисляет возраст относительно receivedAt', () => {
      const receivedAt = Date.now() - 5000; // 5 секунд назад
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [],
        asks: [],
        receivedAt,
      };

      const normalized = OrderbookNormalizer.normalize(raw);
      if (!normalized.ok) throw new Error('Failed to normalize');
      const orderbook = Orderbook.fromNormalized(normalized.value);

      const ageMs = orderbook.getAgeMs();

      expect(ageMs).toBeGreaterThanOrEqual(5000);
      expect(ageMs).toBeLessThan(6000);
    });
  });

  describe('getLatencyMs()', () => {
    it('вычисляет latency если есть venueTimestamp', () => {
      const venueTimestamp = Date.now() - 1000;
      const receivedAt = Date.now();
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [],
        asks: [],
        venueTimestamp,
        receivedAt,
      };

      const normalized = OrderbookNormalizer.normalize(raw);
      if (!normalized.ok) throw new Error('Failed to normalize');
      const orderbook = Orderbook.fromNormalized(normalized.value);

      const latencyMs = orderbook.getLatencyMs();

      expect(latencyMs).not.toBeNull();
      expect(latencyMs!).toBeGreaterThanOrEqual(1000);
    });

    it('возвращает null если нет venueTimestamp', () => {
      const orderbook = createTestOrderbook();

      const latencyMs = orderbook.getLatencyMs();

      expect(latencyMs).toBeNull();
    });
  });

  describe('isStale()', () => {
    it('возвращает true если orderbook старше maxAgeMs', () => {
      const receivedAt = Date.now() - 6000; // 6 секунд назад
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [],
        asks: [],
        receivedAt,
      };

      const normalized = OrderbookNormalizer.normalize(raw);
      if (!normalized.ok) throw new Error('Failed to normalize');
      const orderbook = Orderbook.fromNormalized(normalized.value);

      expect(orderbook.isStale(5000)).toBe(true);
    });

    it('возвращает false если orderbook свежий', () => {
      const orderbook = createTestOrderbook();

      expect(orderbook.isStale(5000)).toBe(false);
    });
  });

  describe('toString()', () => {
    it('возвращает строковое представление', () => {
      const orderbook = createTestOrderbook();

      const str = orderbook.toString();

      expect(str).toContain('market-123');
      expect(str).toContain('token-yes');
      expect(str).toContain('2 bids');
      expect(str).toContain('2 asks');
      expect(str).toContain('spread');
    });
  });

  describe('toObject()', () => {
    it('возвращает summary view', () => {
      const orderbook = createTestOrderbook();

      const obj = orderbook.toObject();

      expect(obj.instrumentId).toBe('market-123');
      expect(obj.asset).toBe('token-yes');
      expect(obj.bestBid).toBe(0.52);
      expect(obj.bestAsk).toBe(0.53);
      expect(obj.midPrice).toBe(0.525);
      expect(obj.spreadWidth).toBe(0.01);
      expect(obj.spreadStatus).toBe('ok');
      expect(obj.bidDepth).toBe(2);
      expect(obj.askDepth).toBe(2);
      expect(obj.totalBidVolume).toBe(300);
      expect(obj.totalAskVolume).toBe(400);
    });

    it('включает spreadStatus при ошибке', () => {
      const orderbook = createTestOrderbook({ bids: [] });

      const obj = orderbook.toObject();

      expect(obj.spreadStatus).toBe(OrderbookInvalidReason.ONE_SIDED);
    });
  });
});
