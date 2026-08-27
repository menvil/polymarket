/**
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import { Orderbook } from '../../../src/core/Orderbook.js';
import { OrderbookLevel } from '../../../src/core/OrderbookLevel.js';
import { OrderbookNormalizer } from '../../../src/normalizer/OrderbookNormalizer.js';
import { PERMISSIVE_NORMALIZATION_POLICY } from '../../../src/normalizer/NormalizationPolicy.js';
import { OrderbookInvalidReason } from '@polymarket/errors/orderbook';
import { OutcomePriceService, QuantityService } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import type { RawOrderbook } from '../../../src/normalizer/types.js';
import type { InstrumentId } from '@polymarket/ids';
import { bookPricing } from '../../../src/index.js';
import { KnownVenues, MarketId } from '@polymarket/ids';

/** Метрики prediction-домена: фабрика связывается один раз. */
const pricing = bookPricing(OutcomePriceService.create);

/** Создаёт OrderbookLevel из примитивов (для fromLevels() — минует нормализатор). */
function testLevel(price: number, quantity: number): OrderbookLevel {
  const p = OutcomePriceService.create(price);
  const q = QuantityService.create(quantity);
  if (!p.ok) throw new Error(`Invalid price: ${price}`);
  if (!q.ok) throw new Error(`Invalid quantity: ${quantity}`);
  return OrderbookLevel.create(p.value, q.value);
}

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
    return Orderbook.fromNormalized(normalized.value, KnownVenues.POLYMARKET);
  };

  describe('fromNormalized()', () => {
    it('создаёт Orderbook из нормализованных данных', () => {
      const orderbook = createTestOrderbook();

      expect(orderbook.marketId).toBe('market-123');
      expect(orderbook.instrumentId).toBe('token-yes');
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
      const orderbook = Orderbook.fromNormalized(normalized.value, KnownVenues.POLYMARKET);

      expect(orderbook.venueTimestamp?.toNumber()).toBe(venueTimestamp);
      expect(orderbook.receivedAt.toNumber()).toBe(receivedAt);
    });
  });

  describe('empty()', () => {
    it('создаёт пустой orderbook', () => {
      const orderbook = Orderbook.empty(KnownVenues.POLYMARKET, 'token-yes' as InstrumentId, 'market-123' as unknown as MarketId);

      expect(orderbook.isEmpty()).toBe(true);
      expect(orderbook.bids.length).toBe(0);
      expect(orderbook.asks.length).toBe(0);
    });
  });

  describe('fromLevels()', () => {
    const instrumentId = 'market-123' as InstrumentId;
    const asset = 'token-yes' as InstrumentId;

    it('создаёт Orderbook напрямую из уровней, минуя нормализатор', () => {
      const orderbook = Orderbook.fromLevels({
      venueId: KnownVenues.POLYMARKET,
      marketId: instrumentId as unknown as MarketId,
      instrumentId: asset,
      bids: [testLevel(0.52, 100)],
      asks: [testLevel(0.53, 150)],
      receivedAt: Timestamp.now(),
    });

      expect(orderbook.marketId).toBe('market-123');
      expect(orderbook.instrumentId).toBe('token-yes');
      expect(orderbook.bids.length).toBe(1);
      expect(orderbook.asks.length).toBe(1);
    });

    it('возвращает frozen объект', () => {
      const orderbook = Orderbook.fromLevels({
      venueId: KnownVenues.POLYMARKET,
      marketId: instrumentId as unknown as MarketId,
      instrumentId: asset,
      bids: [],
      asks: [],
      receivedAt: Timestamp.now(),
    });
      expect(Object.isFrozen(orderbook)).toBe(true);
    });

    it('сортирует bids по убыванию цены, даже если переданы не по порядку', () => {
      const orderbook = Orderbook.fromLevels({
      venueId: KnownVenues.POLYMARKET,
      marketId: instrumentId as unknown as MarketId,
      instrumentId: asset,
      bids: [testLevel(0.51, 100), testLevel(0.53, 50), testLevel(0.52, 200)],
      asks: // намеренно не отсортированы
        [],
      receivedAt: Timestamp.now(),
    });

      expect(orderbook.bids.map((l) => l.price.value().toNumber())).toEqual([0.53, 0.52, 0.51]);
    });

    it('сортирует asks по возрастанию цены, даже если переданы не по порядку', () => {
      const orderbook = Orderbook.fromLevels({
      venueId: KnownVenues.POLYMARKET,
      marketId: instrumentId as unknown as MarketId,
      instrumentId: asset,
      bids: [],
      asks: [testLevel(0.55, 100), testLevel(0.53, 50), testLevel(0.54, 200)],
      receivedAt: // намеренно не отсортированы
        Timestamp.now(),
    });

      expect(orderbook.asks.map((l) => l.price.value().toNumber())).toEqual([0.53, 0.54, 0.55]);
    });

    it('неотсортированный вход не ломает getBestBid()/getBestAsk() (защитная сортировка)', () => {
      const orderbook = Orderbook.fromLevels({
      venueId: KnownVenues.POLYMARKET,
      marketId: instrumentId as unknown as MarketId,
      instrumentId: asset,
      bids: [testLevel(0.51, 100), testLevel(0.53, 50)],
      asks: [testLevel(0.56, 100), testLevel(0.54, 50)],
      receivedAt: Timestamp.now(),
    });

      expect(orderbook.getBestBid()?.value().toNumber()).toBe(0.53);
      expect(orderbook.getBestAsk()?.value().toNumber()).toBe(0.54);
    });

    it('сохраняет receivedAt (обязателен) и venueTimestamp (опционален)', () => {
      const receivedAt = Timestamp.now();
      const withVenue = Orderbook.fromLevels({
      venueId: KnownVenues.POLYMARKET,
      marketId: instrumentId as unknown as MarketId,
      instrumentId: asset,
      bids: [],
      asks: [],
      receivedAt: receivedAt,
      venueTimestamp: receivedAt,
    });
      const withoutVenue = Orderbook.fromLevels({
      venueId: KnownVenues.POLYMARKET,
      marketId: instrumentId as unknown as MarketId,
      instrumentId: asset,
      bids: [],
      asks: [],
      receivedAt: receivedAt,
    });

      expect(withVenue.receivedAt).toBe(receivedAt);
      expect(withVenue.venueTimestamp).toBe(receivedAt);
      expect(withoutVenue.receivedAt).toBe(receivedAt);
      expect(withoutVenue.venueTimestamp).toBeUndefined();
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

      const spreadResult = pricing.spread(orderbook);

      expect(spreadResult.ok).toBe(true);
      if (spreadResult.ok) {
        expect(spreadResult.value.width().toNumber()).toBe(0.01); // 0.53 - 0.52
      }
    });

    it('возвращает Err(EMPTY_BOOK) для пустого orderbook', () => {
      const orderbook = createTestOrderbook({ bids: [], asks: [] });

      const spreadResult = pricing.spread(orderbook);

      expect(spreadResult.ok).toBe(false);
      if (!spreadResult.ok) {
        expect(spreadResult.error.getReason()).toBe(OrderbookInvalidReason.EMPTY_BOOK);
      }
    });

    it('возвращает Err(ONE_SIDED) если есть только bids', () => {
      const orderbook = createTestOrderbook({ asks: [] });

      const spreadResult = pricing.spread(orderbook);

      expect(spreadResult.ok).toBe(false);
      if (!spreadResult.ok) {
        expect(spreadResult.error.getReason()).toBe(OrderbookInvalidReason.ONE_SIDED);
      }
    });

    it('возвращает Err(ONE_SIDED) если есть только asks', () => {
      const orderbook = createTestOrderbook({ bids: [] });

      const spreadResult = pricing.spread(orderbook);

      expect(spreadResult.ok).toBe(false);
      if (!spreadResult.ok) {
        expect(spreadResult.error.getReason()).toBe(OrderbookInvalidReason.ONE_SIDED);
      }
    });
  });

  describe('getMidPrice()', () => {
    it('возвращает mid price', () => {
      const orderbook = createTestOrderbook();

      const midPrice = pricing.midPrice(orderbook);

      expect(midPrice).not.toBeNull();
      expect(midPrice!.value().toNumber()).toBe(0.525); // (0.52 + 0.53) / 2
    });

    it('возвращает null если нет spread', () => {
      const orderbook = createTestOrderbook({ bids: [] });

      const midPrice = pricing.midPrice(orderbook);

      expect(midPrice).toBeNull();
    });
  });

  describe('getMicroprice()', () => {
    it('вычисляет microprice с учётом объёмов', () => {
      const orderbook = createTestOrderbook({
        bids: [{ price: 0.50, quantity: 100 }],
        asks: [{ price: 0.52, quantity: 200 }],
      });

      const microprice = pricing.microprice(orderbook);

      expect(microprice).not.toBeNull();
      // microprice = (0.52 * 100 + 0.50 * 200) / (100 + 200)
      //            = (52 + 100) / 300 = 0.5067
      expect(microprice!.value().toNumber()).toBeCloseTo(0.5067, 4);
    });

    it('возвращает null если нет bid или ask', () => {
      const orderbook = createTestOrderbook({ bids: [] });

      const microprice = pricing.microprice(orderbook);

      expect(microprice).toBeNull();
    });

    it('возвращает null если сумма qty = 0', () => {
      const orderbook = createTestOrderbook({
        bids: [{ price: 0.52, quantity: 0 }],
        asks: [{ price: 0.53, quantity: 0 }],
      });

      const microprice = pricing.microprice(orderbook);

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

    it('getTotalBidVolume(0) возвращает 0 (не все уровни)', () => {
      const ob = createTestOrderbook();
      expect(ob.getTotalBidVolume(0).value().toNumber()).toBe(0);
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

    it('getTotalAskVolume(0) возвращает 0 (не все уровни)', () => {
      const ob = createTestOrderbook();
      expect(ob.getTotalAskVolume(0).value().toNumber()).toBe(0);
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

    it('getImbalance(0) возвращает 0 (нет уровней для расчёта)', () => {
      const ob = createTestOrderbook();
      expect(ob.getImbalance(0)).toBe(0);
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
      const BASE = 1_700_000_000_000; // детерминированное время
      const receivedAt = BASE - 5000;
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [],
        asks: [],
        receivedAt,
      };

      const normalized = OrderbookNormalizer.normalize(raw);
      if (!normalized.ok) throw new Error('Failed to normalize');
      const orderbook = Orderbook.fromNormalized(normalized.value, KnownVenues.POLYMARKET);

      const ageMs = orderbook.getAgeMs(BASE); // передаём nowMs явно

      expect(ageMs).toBe(5000);
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
      const orderbook = Orderbook.fromNormalized(normalized.value, KnownVenues.POLYMARKET);

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
      const BASE = 1_700_000_000_000; // детерминированное время
      const receivedAt = BASE - 6000;
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [],
        asks: [],
        receivedAt,
      };

      const normalized = OrderbookNormalizer.normalize(raw);
      if (!normalized.ok) throw new Error('Failed to normalize');
      const orderbook = Orderbook.fromNormalized(normalized.value, KnownVenues.POLYMARKET);

      expect(orderbook.isStale(5000, BASE)).toBe(true); // 6000 > 5000
    });

    it('возвращает false если orderbook свежий', () => {
      const BASE = 1_700_000_000_000;
      const receivedAt = BASE - 100; // 100ms назад
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [],
        asks: [],
        receivedAt,
      };

      const normalized = OrderbookNormalizer.normalize(raw);
      if (!normalized.ok) throw new Error('Failed to normalize');
      const orderbook = Orderbook.fromNormalized(normalized.value, KnownVenues.POLYMARKET);

      expect(orderbook.isStale(5000, BASE)).toBe(false); // 100ms < 5000ms
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
      // Ширина спреда — производная ЦЕНА и в структурном представлении её
      // больше нет; вместо неё показываются выбранные лучшие уровни
      expect(str).toContain('top 0.5200/0.5300');
    });
  });

  describe('toObject()', () => {
    it('возвращает summary view', () => {
      const orderbook = createTestOrderbook();

      const obj = orderbook.toObject();

      expect(obj.venueId).toBe('POLYMARKET');
      expect(obj.marketId).toBe('market-123');
      expect(obj.instrumentId).toBe('token-yes');
      expect(obj.bestBid).toBe(0.52);
      expect(obj.bestAsk).toBe(0.53);
      // Производные цены (mid/микроцена/спред) в структурную сводку больше
      // не входят — их вычисление требует фабрики домена, см. bookPricing
      expect('midPrice' in obj).toBe(false);
      expect('spreadWidth' in obj).toBe(false);
      expect(obj.bidDepth).toBe(2);
      expect(obj.askDepth).toBe(2);
      expect(obj.totalBidVolume).toBe(300);
      expect(obj.totalAskVolume).toBe(400);
    });

    it('односторонний стакан отражается отсутствующей стороной, а не статусом', () => {
      const orderbook = createTestOrderbook({ bids: [] });

      const obj = orderbook.toObject();

      // Статус спреда — это уже ЦЕНОВАЯ метрика; структурная сводка честно
      // показывает, что стороны bid нет
      expect(obj.bestBid).toBeUndefined();
      expect(obj.bidDepth).toBe(0);
      expect(pricing.spread(orderbook).ok).toBe(false);
    });
  });

  describe('spread() — crossed book через permissive normalizer', () => {
    it('возвращает CROSSED_BOOK error для crossed стакана (из permissive normalizer)', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [{ price: 0.60, quantity: 100 }],
        asks: [{ price: 0.50, quantity: 100 }],
      };
      // PERMISSIVE позволяет crossed book пройти нормализацию
      const normalized = OrderbookNormalizer.normalize(raw, PERMISSIVE_NORMALIZATION_POLICY);
      expect(normalized.ok).toBe(true);
      if (!normalized.ok) return;
      const ob = Orderbook.fromNormalized(normalized.value, KnownVenues.POLYMARKET);
      const spreadResult = pricing.spread(ob);
      expect(spreadResult.ok).toBe(false);
      if (spreadResult.ok) return;
      expect(spreadResult.error.isCrossedBook()).toBe(true);
    });
  });
});
