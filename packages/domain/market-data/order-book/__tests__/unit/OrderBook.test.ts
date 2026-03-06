import { describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { asMarketId } from '@polymarket/ids';
import { OrderBook } from '../../src/OrderBook.js';
import type { PriceLevel } from '../../src/PriceLevel.js';
import type { OrderBookDelta } from '../../src/OrderBookDelta.js';

const MARKET_ID = asMarketId('market-abc')!;

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
      const bids: PriceLevel[] = [
        { price: 0.65, size: 1000 },
        { price: 0.64, size: 500 },
      ];
      const asks: PriceLevel[] = [
        { price: 0.66, size: 800 },
      ];

      book.applyFullState(bids, asks);

      expect(book.getBestBid()).toEqual({ price: 0.65, size: 1000 });
      expect(book.getBestAsk()).toEqual({ price: 0.66, size: 800 });
      expect(book.isEmpty()).toBe(false);
    });

    it('заменяет предыдущее состояние полностью', () => {
      book.applyFullState(
        [{ price: 0.65, size: 1000 }],
        [{ price: 0.66, size: 800 }]
      );
      book.applyFullState(
        [{ price: 0.70, size: 200 }],
        []
      );

      expect(book.getBestBid()).toEqual({ price: 0.70, size: 200 });
      expect(book.getBestAsk()).toBeUndefined();
    });

    it('игнорирует уровни с size <= 0', () => {
      book.applyFullState(
        [{ price: 0.65, size: 0 }, { price: 0.64, size: -100 }],
        [{ price: 0.66, size: 500 }]
      );

      expect(book.getBestBid()).toBeUndefined();
      expect(book.getBids()).toHaveLength(0);
    });
  });

  // ==================== applyDelta ====================

  describe('applyDelta()', () => {
    beforeEach(() => {
      book.applyFullState(
        [{ price: 0.65, size: 1000 }, { price: 0.64, size: 500 }],
        [{ price: 0.66, size: 800 }, { price: 0.67, size: 300 }]
      );
    });

    it('обновляет существующий уровень', () => {
      const delta: OrderBookDelta = {
        bids: [{ price: 0.65, size: 2000 }],
        asks: [],
      };
      book.applyDelta(delta);

      expect(book.getBestBid()).toEqual({ price: 0.65, size: 2000 });
    });

    it('добавляет новый уровень', () => {
      const delta: OrderBookDelta = {
        bids: [{ price: 0.63, size: 750 }],
        asks: [],
      };
      book.applyDelta(delta);

      const bids = book.getBids();
      expect(bids).toHaveLength(3);
      expect(bids[bids.length - 1]).toEqual({ price: 0.63, size: 750 });
    });

    it('удаляет уровень при size === 0', () => {
      const delta: OrderBookDelta = {
        bids: [],
        asks: [{ price: 0.66, size: 0 }],
      };
      book.applyDelta(delta);

      const asks = book.getAsks();
      expect(asks).toHaveLength(1);
      expect(asks[0]).toEqual({ price: 0.67, size: 300 });
    });

    it('игнорирует уровни с size < 0', () => {
      const delta: OrderBookDelta = {
        bids: [{ price: 0.65, size: -500 }],
        asks: [],
      };
      book.applyDelta(delta);

      expect(book.getBestBid()).toEqual({ price: 0.65, size: 1000 });
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
        [
          { price: 0.64, size: 200 },
          { price: 0.65, size: 1000 },
          { price: 0.63, size: 300 },
        ],
        []
      );

      expect(book.getBestBid()).toEqual({ price: 0.65, size: 1000 });
    });

    it('возвращает ask с наименьшей ценой', () => {
      book.applyFullState(
        [],
        [
          { price: 0.67, size: 300 },
          { price: 0.66, size: 800 },
          { price: 0.68, size: 100 },
        ]
      );

      expect(book.getBestAsk()).toEqual({ price: 0.66, size: 800 });
    });
  });

  // ==================== getMidPrice / getSpread ====================

  describe('getMidPrice() / getSpread()', () => {
    it('возвращает undefined для пустого стакана', () => {
      expect(book.getMidPrice()).toBeUndefined();
      expect(book.getSpread()).toBeUndefined();
    });

    it('вычисляет mid price корректно', () => {
      book.applyFullState(
        [{ price: 0.65, size: 1000 }],
        [{ price: 0.67, size: 800 }]
      );

      expect(book.getMidPrice()!.toNumber()).toBeCloseTo(0.66);
    });

    it('вычисляет спред корректно', () => {
      book.applyFullState(
        [{ price: 0.65, size: 1000 }],
        [{ price: 0.67, size: 800 }]
      );

      expect(book.getSpread()!.toNumber()).toBeCloseTo(0.02);
    });

    it('возвращает undefined если есть только bid', () => {
      book.applyFullState([{ price: 0.65, size: 1000 }], []);

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
      book.applyFullState(
        [{ price: 0.65, size: 1500 }],
        [{ price: 0.66, size: 500 }]
      );

      // (1500 - 500) / (1500 + 500) = 1000/2000 = 0.5
      expect(book.getImbalance().toNumber()).toBeCloseTo(0.5);
    });

    it('вычисляет дисбаланс корректно (ask > bid)', () => {
      book.applyFullState(
        [{ price: 0.65, size: 300 }],
        [{ price: 0.66, size: 700 }]
      );

      // (300 - 700) / (300 + 700) = -400/1000 = -0.4
      expect(book.getImbalance().toNumber()).toBeCloseTo(-0.4);
    });

    it('учитывает только topLevels уровней', () => {
      book.applyFullState(
        [
          { price: 0.65, size: 1000 },
          { price: 0.64, size: 5000 }, // игнорируется при topLevels=1
        ],
        [{ price: 0.66, size: 800 }]
      );

      // top 1: bid=1000, ask=800 → (1000-800)/(1000+800) ≈ 0.111
      expect(book.getImbalance(1).toNumber()).toBeCloseTo(0.111, 2);

      // все уровни: bid=6000, ask=800 → (6000-800)/(6000+800) ≈ 0.765
      expect(book.getImbalance().toNumber()).toBeCloseTo(0.765, 2);
    });

    it('возвращает Decimal(1) если только bids', () => {
      book.applyFullState([{ price: 0.65, size: 1000 }], []);
      expect(book.getImbalance().toNumber()).toBe(1);
    });

    it('возвращает Decimal(-1) если только asks', () => {
      book.applyFullState([], [{ price: 0.66, size: 800 }]);
      expect(book.getImbalance().toNumber()).toBe(-1);
    });

    it('возвращает Decimal, а не number', () => {
      book.applyFullState([{ price: 0.65, size: 1000 }], []);
      expect(book.getImbalance()).toBeInstanceOf(Decimal);
    });
  });

  // ==================== getBids / getAsks ====================

  describe('getBids() / getAsks()', () => {
    beforeEach(() => {
      book.applyFullState(
        [
          { price: 0.63, size: 300 },
          { price: 0.65, size: 1000 },
          { price: 0.64, size: 500 },
        ],
        [
          { price: 0.68, size: 100 },
          { price: 0.66, size: 800 },
          { price: 0.67, size: 300 },
        ]
      );
    });

    it('возвращает bids отсортированные по убыванию цены', () => {
      const bids = book.getBids();
      expect(bids).toHaveLength(3);
      expect(bids[0]!.price).toBe(0.65);
      expect(bids[1]!.price).toBe(0.64);
      expect(bids[2]!.price).toBe(0.63);
    });

    it('возвращает asks отсортированные по возрастанию цены', () => {
      const asks = book.getAsks();
      expect(asks).toHaveLength(3);
      expect(asks[0]!.price).toBe(0.66);
      expect(asks[1]!.price).toBe(0.67);
      expect(asks[2]!.price).toBe(0.68);
    });

    it('ограничивает количество уровней', () => {
      expect(book.getBids(2)).toHaveLength(2);
      expect(book.getAsks(1)).toHaveLength(1);
    });
  });

  // ==================== toSnapshot ====================

  describe('toSnapshot()', () => {
    it('создаёт корректный снапшот', () => {
      book.applyFullState(
        [{ price: 0.65, size: 1000 }],
        [{ price: 0.66, size: 800 }]
      );

      const snapshot = book.toSnapshot(1700000000000);

      expect(snapshot.marketId).toBe('market-abc');
      expect(snapshot.tokenId).toBe('token-yes');
      expect(snapshot.bids).toEqual([{ price: 0.65, size: 1000 }]);
      expect(snapshot.asks).toEqual([{ price: 0.66, size: 800 }]);
      expect(snapshot.timestampMs).toBe(1700000000000);
    });

    it('timestampMs опционален', () => {
      const snapshot = book.toSnapshot();
      expect(snapshot.timestampMs).toBeUndefined();
    });
  });
});
