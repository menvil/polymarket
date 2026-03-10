import { describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { asMarketId } from '@polymarket/ids';
import { PriceService, QuantityService, TimestampService } from '@polymarket/value-objects';
import type { Price, Quantity } from '@polymarket/value-objects';
// Quantity используется в тесте с отрицательным size через cast
import { OrderBook } from '../../src/OrderBook.js';
import type { PriceLevel } from '../../src/PriceLevel.js';
import type { OrderBookDelta } from '../../src/OrderBookDelta.js';

const MARKET_ID = asMarketId('market-abc')!;

// ==================== Вспомогательные функции ====================

/** Создаёт PriceLevel с Price и Quantity VO из primitives */
function level(price: number | string, size: number | string): PriceLevel {
  const p = PriceService.create(price);
  const s = QuantityService.create(size);
  if (!p.ok) throw new Error(`Invalid price: ${price} — ${p.error.message}`);
  if (!s.ok) throw new Error(`Invalid size: ${size} — ${s.error.message}`);
  return { price: p.value, size: s.value };
}

/** Создаёт Price VO */
function price(v: number | string): Price {
  const r = PriceService.create(v);
  if (!r.ok) throw new Error(`Invalid price: ${v}`);
  return r.value;
}

// ==================== Тесты ====================

describe('OrderBook', () => {
  let book: OrderBook;

  beforeEach(() => {
    book = OrderBook.create(MARKET_ID, 'token-yes');
  });

  // ==================== create ====================

  describe('create()', () => {
    it('создаёт пустой стакан', () => {
      expect(book.marketId).toBe('market-abc');
      expect(book.tokenId).toBe('token-yes');
      expect(book.isEmpty()).toBe(true);
    });
  });

  // ==================== applyFullState ====================

  describe('applyFullState()', () => {
    it('устанавливает уровни bid и ask', () => {
      book.applyFullState(
        [level(0.65, 1000), level(0.64, 500)],
        [level(0.66, 800)]
      );

      const bid = book.getBestBid()!;
      const ask = book.getBestAsk()!;
      expect(bid.price.value().toNumber()).toBe(0.65);
      expect(bid.size.value().toNumber()).toBe(1000);
      expect(ask.price.value().toNumber()).toBe(0.66);
      expect(ask.size.value().toNumber()).toBe(800);
      expect(book.isEmpty()).toBe(false);
    });

    it('заменяет предыдущее состояние полностью', () => {
      book.applyFullState([level(0.65, 1000)], [level(0.66, 800)]);
      book.applyFullState([level(0.70, 200)], []);

      expect(book.getBestBid()!.price.value().toNumber()).toBe(0.70);
      expect(book.getBestAsk()).toBeUndefined();
    });

    it('игнорирует уровни с size <= 0', () => {
      book.applyFullState(
        [level(0.65, 0), level('0.64', 0)],
        [level(0.66, 500)]
      );

      expect(book.getBestBid()).toBeUndefined();
      expect(book.getBids()).toHaveLength(0);
    });
  });

  // ==================== applyDelta ====================

  describe('applyDelta()', () => {
    beforeEach(() => {
      book.applyFullState(
        [level(0.65, 1000), level(0.64, 500)],
        [level(0.66, 800), level(0.67, 300)]
      );
    });

    it('обновляет существующий уровень', () => {
      const delta: OrderBookDelta = {
        bids: [level(0.65, 2000)],
        asks: [],
      };
      book.applyDelta(delta);

      expect(book.getBestBid()!.price.value().toNumber()).toBe(0.65);
      expect(book.getBestBid()!.size.value().toNumber()).toBe(2000);
    });

    it('добавляет новый уровень', () => {
      const delta: OrderBookDelta = {
        bids: [level(0.63, 750)],
        asks: [],
      };
      book.applyDelta(delta);

      const bids = book.getBids();
      expect(bids).toHaveLength(3);
      expect(bids[bids.length - 1]!.price.value().toNumber()).toBe(0.63);
      expect(bids[bids.length - 1]!.size.value().toNumber()).toBe(750);
    });

    it('удаляет уровень при size === 0', () => {
      const delta: OrderBookDelta = {
        bids: [],
        asks: [level(0.66, 0)],
      };
      book.applyDelta(delta);

      const asks = book.getAsks();
      expect(asks).toHaveLength(1);
      expect(asks[0]!.price.value().toNumber()).toBe(0.67);
    });

    it('игнорирует уровни с size < 0', () => {
      // Создаём PriceLevel напрямую с отрицательным qty через cast (size < 0)
      const negQty = { value: () => new Decimal('-500'), isZero: () => false } as unknown as Quantity;
      const delta: OrderBookDelta = {
        bids: [{ price: price(0.65), size: negQty }],
        asks: [],
      };
      book.applyDelta(delta);

      // bid 0.65 остался нетронутым
      expect(book.getBestBid()!.size.value().toNumber()).toBe(1000);
    });
  });

  // ==================== getBestBid / getBestAsk ====================

  describe('getBestBid() / getBestAsk()', () => {
    it('возвращает undefined для пустого стакана', () => {
      expect(book.getBestBid()).toBeUndefined();
      expect(book.getBestAsk()).toBeUndefined();
    });

    it('возвращает bid с наибольшей ценой', () => {
      book.applyFullState(
        [level(0.64, 200), level(0.65, 1000), level(0.63, 300)],
        []
      );

      expect(book.getBestBid()!.price.value().toNumber()).toBe(0.65);
    });

    it('возвращает ask с наименьшей ценой', () => {
      book.applyFullState(
        [],
        [level(0.67, 300), level(0.66, 800), level(0.68, 100)]
      );

      expect(book.getBestAsk()!.price.value().toNumber()).toBe(0.66);
    });
  });

  // ==================== getMidPrice / getSpread ====================

  describe('getMidPrice() / getSpread()', () => {
    it('возвращает undefined для пустого стакана', () => {
      expect(book.getMidPrice()).toBeUndefined();
      expect(book.getSpread()).toBeUndefined();
    });

    it('вычисляет mid price корректно', () => {
      book.applyFullState([level(0.65, 1000)], [level(0.67, 800)]);

      expect(book.getMidPrice()!.toNumber()).toBeCloseTo(0.66);
    });

    it('вычисляет спред корректно', () => {
      book.applyFullState([level(0.65, 1000)], [level(0.67, 800)]);

      expect(book.getSpread()!.toNumber()).toBeCloseTo(0.02);
    });

    it('возвращает undefined если есть только bid', () => {
      book.applyFullState([level(0.65, 1000)], []);

      expect(book.getMidPrice()).toBeUndefined();
      expect(book.getSpread()).toBeUndefined();
    });
  });

  // ==================== getImbalance ====================

  describe('getImbalance()', () => {
    it('возвращает Decimal(0) для пустого стакана', () => {
      expect(book.getImbalance().isZero()).toBe(true);
    });

    it('вычисляет дисбаланс корректно (bid > ask)', () => {
      book.applyFullState([level(0.65, 1500)], [level(0.66, 500)]);

      // (1500 - 500) / (1500 + 500) = 1000/2000 = 0.5
      expect(book.getImbalance().toNumber()).toBeCloseTo(0.5);
    });

    it('вычисляет дисбаланс корректно (ask > bid)', () => {
      book.applyFullState([level(0.65, 300)], [level(0.66, 700)]);

      // (300 - 700) / (300 + 700) = -400/1000 = -0.4
      expect(book.getImbalance().toNumber()).toBeCloseTo(-0.4);
    });

    it('учитывает только topLevels уровней', () => {
      book.applyFullState(
        [level(0.65, 1000), level(0.64, 5000)], // 5000 игнорируется при topLevels=1
        [level(0.66, 800)]
      );

      // top 1: bid=1000, ask=800 → (1000-800)/(1000+800) ≈ 0.111
      expect(book.getImbalance(1).toNumber()).toBeCloseTo(0.111, 2);

      // все уровни: bid=6000, ask=800 → (6000-800)/(6000+800) ≈ 0.765
      expect(book.getImbalance().toNumber()).toBeCloseTo(0.765, 2);
    });

    it('возвращает Decimal(1) если только bids', () => {
      book.applyFullState([level(0.65, 1000)], []);
      expect(book.getImbalance().toNumber()).toBe(1);
    });

    it('возвращает Decimal(-1) если только asks', () => {
      book.applyFullState([], [level(0.66, 800)]);
      expect(book.getImbalance().toNumber()).toBe(-1);
    });

    it('возвращает Decimal, а не number', () => {
      book.applyFullState([level(0.65, 1000)], []);
      expect(book.getImbalance()).toBeInstanceOf(Decimal);
    });
  });

  // ==================== getBids / getAsks ====================

  describe('getBids() / getAsks()', () => {
    beforeEach(() => {
      book.applyFullState(
        [level(0.63, 300), level(0.65, 1000), level(0.64, 500)],
        [level(0.68, 100), level(0.66, 800), level(0.67, 300)]
      );
    });

    it('возвращает bids отсортированные по убыванию цены', () => {
      const bids = book.getBids();
      expect(bids).toHaveLength(3);
      expect(bids[0]!.price.value().toNumber()).toBe(0.65);
      expect(bids[1]!.price.value().toNumber()).toBe(0.64);
      expect(bids[2]!.price.value().toNumber()).toBe(0.63);
    });

    it('возвращает asks отсортированные по возрастанию цены', () => {
      const asks = book.getAsks();
      expect(asks).toHaveLength(3);
      expect(asks[0]!.price.value().toNumber()).toBe(0.66);
      expect(asks[1]!.price.value().toNumber()).toBe(0.67);
      expect(asks[2]!.price.value().toNumber()).toBe(0.68);
    });

    it('ограничивает количество уровней', () => {
      expect(book.getBids(2)).toHaveLength(2);
      expect(book.getAsks(1)).toHaveLength(1);
    });
  });

  // ==================== toSnapshot ====================

  describe('toSnapshot()', () => {
    it('создаёт корректный снапшот с timestamp из applyFullState', () => {
      const tsResult = TimestampService.create(1700000000000);
      if (!tsResult.ok) throw new Error('Invalid timestamp');
      const ts = tsResult.value;

      book.applyFullState([level(0.65, 1000)], [level(0.66, 800)], ts);

      const snapshot = book.toSnapshot();

      expect(snapshot.marketId).toBe('market-abc');
      expect(snapshot.tokenId).toBe('token-yes');
      expect(snapshot.bids).toHaveLength(1);
      expect(snapshot.bids[0]!.price.value().toNumber()).toBe(0.65);
      expect(snapshot.bids[0]!.size.value().toNumber()).toBe(1000);
      expect(snapshot.asks[0]!.price.value().toNumber()).toBe(0.66);
      expect(snapshot.asks[0]!.size.value().toNumber()).toBe(800);
      expect(snapshot.timestamp).toBe(ts);
    });

    it('timestamp undefined если applyFullState не вызывался', () => {
      const snapshot = book.toSnapshot();
      expect(snapshot.timestamp).toBeUndefined();
    });
  });

  // ==================== Price/Quantity VO types ====================

  describe('типы Price/Quantity VO', () => {
    it('getBestBid().price является Price VO с методом value()', () => {
      book.applyFullState([level('0.43', '41')], [level('0.44', '253.92')]);
      const bid = book.getBestBid()!;
      expect(bid.price.value()).toBeInstanceOf(Decimal);
      expect(bid.size.value()).toBeInstanceOf(Decimal);
    });

    it('корректно обрабатывает строковые значения (Polymarket формат)', () => {
      book.applyFullState(
        [level('0.43', '41'), level('0.42', '194.5')],
        [level('0.44', '253.92')]
      );
      expect(book.getBestBid()!.price.value().toNumber()).toBe(0.43);
      expect(book.getBestBid()!.size.value().toNumber()).toBe(41);
      expect(book.getBestAsk()!.price.value().toNumber()).toBe(0.44);
      expect(book.getBestAsk()!.size.value().toNumber()).toBeCloseTo(253.92);
    });

    it('qty() типа Quantity для size', () => {
      book.applyFullState([level(0.65, 1000)], []);
      const bid = book.getBestBid()!;
      // Quantity должен иметь метод value() возвращающий Decimal
      expect(typeof bid.size.value).toBe('function');
      expect(bid.size.value().toNumber()).toBe(1000);
    });
  });
});
