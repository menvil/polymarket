/**
 * Orderbook entity tests - рефакторенная версия с Result pattern
 *
 * @remarks
 * Тесты для Orderbook entity после рефакторинга с Result pattern.
 * Покрывают валидацию, создание, сериализацию и рыночные метрики.
 */
import { describe, it, expect } from '@jest/globals';
import { Orderbook, type OrderbookData, type OrderbookLevel } from '../../src/Orderbook.js';
import { Price, Quantity } from '@polymarket/value-objects';
import { OrderbookValidationError } from '@polymarket/errors';

describe('Orderbook Entity (Result pattern)', () => {
  // Helper для создания валидных Price и Quantity
  const createPrice = (value: number): Price => {
    const result = Price.fromValue(value);
    if (!result.ok) throw new Error(`Failed to create Price: ${result.error.message}`);
    return result.value;
  };

  const createQuantity = (value: number): Quantity => {
    const result = Quantity.fromValue(value);
    if (!result.ok) throw new Error(`Failed to create Quantity: ${result.error.message}`);
    return result.value;
  };

  // Helper для создания тестовых уровней
  const createLevel = (price: number, quantity: number): OrderbookLevel => ({
    price: createPrice(price),
    quantity: createQuantity(quantity),
  });

  describe('Orderbook.create() - успешное создание', () => {
    it('должен создать Orderbook с бидами и асками', () => {
      const data: OrderbookData = {
        bids: [
          createLevel(0.52, 100),
          createLevel(0.51, 200),
        ],
        asks: [
          createLevel(0.53, 150),
          createLevel(0.54, 250),
        ],
      };

      const result = Orderbook.create('market-123', 'token-market-123', data);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.marketId).toBe('market-123');
        expect(result.value.bids.length).toBe(2);
        expect(result.value.asks.length).toBe(2);
      }
    });

    it('должен отсортировать bids по убыванию цены', () => {
      const data: OrderbookData = {
        bids: [
          createLevel(0.50, 100),
          createLevel(0.52, 200),
          createLevel(0.51, 150),
        ],
        asks: [],
      };

      const result = Orderbook.create('market-sort', 'token-market-sort', data);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bids[0].price.value).toBe(0.52); // Highest first
        expect(result.value.bids[1].price.value).toBe(0.51);
        expect(result.value.bids[2].price.value).toBe(0.50);
      }
    });

    it('должен отсортировать asks по возрастанию цены', () => {
      const data: OrderbookData = {
        bids: [],
        asks: [
          createLevel(0.56, 100),
          createLevel(0.54, 200),
          createLevel(0.55, 150),
        ],
      };

      const result = Orderbook.create('market-sort', 'token-market-sort', data);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.asks[0].price.value).toBe(0.54); // Lowest first
        expect(result.value.asks[1].price.value).toBe(0.55);
        expect(result.value.asks[2].price.value).toBe(0.56);
      }
    });

    it('должен использовать timestamp из параметров', () => {
      const customTimestamp = new Date('2024-01-15T10:00:00Z');
      const data: OrderbookData = {
        bids: [createLevel(0.5, 100)],
        asks: [createLevel(0.51, 100)],
        timestamp: customTimestamp,
      };

      const result = Orderbook.create('market-ts', 'token-market-ts', data);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.timestamp).toEqual(customTimestamp);
      }
    });

    it('должен использовать текущее время если timestamp не указан', () => {
      const before = Date.now();
      const data: OrderbookData = {
        bids: [],
        asks: [],
      };

      const result = Orderbook.create('market-now', 'token-market-now', data);
      const after = Date.now();

      expect(result.ok).toBe(true);
      if (result.ok) {
        const ts = result.value.timestamp.getTime();
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
      }
    });
  });

  describe('Orderbook.create() - валидация', () => {
    it('должен вернуть ошибку если marketId пустой', () => {
      const result = Orderbook.create('', 'token-', { bids: [], asks: [] });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderbookValidationError);
        expect(result.error.message).toContain('Market ID must be a non-empty string');
      }
    });

    it('должен вернуть ошибку если bids не массив', () => {
      const result = Orderbook.create('market-bad', 'token-market-bad', { bids: 'invalid' as any, asks: [] });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderbookValidationError);
        expect(result.error.message).toContain('Bids must be an array');
      }
    });

    it('должен вернуть ошибку если asks не массив', () => {
      const result = Orderbook.create('market-bad', 'token-market-bad', { bids: [], asks: null as any });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderbookValidationError);
        expect(result.error.message).toContain('Asks must be an array');
      }
    });
  });

  describe('Orderbook.empty()', () => {
    it('должен создать пустой Orderbook', () => {
      const result = Orderbook.empty('market-empty', 'token-market-empty');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.marketId).toBe('market-empty');
        expect(result.value.bids.length).toBe(0);
        expect(result.value.asks.length).toBe(0);
        expect(result.value.isEmpty()).toBe(true);
      }
    });
  });

  describe('Orderbook.fromJSON() и toJSON()', () => {
    it('должен создать Orderbook из валидного JSON', () => {
      const json = {
        marketId: 'market-json',
        tokenId: 'token-market-json',
        timestamp: '2024-01-15T12:00:00Z',
        bids: [
          { price: 0.52, quantity: 100 },
          { price: 0.51, quantity: 200 },
        ],
        asks: [
          { price: 0.53, quantity: 150 },
        ],
      };

      const result = Orderbook.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.marketId).toBe('market-json');
        expect(result.value.bids.length).toBe(2);
        expect(result.value.asks.length).toBe(1);
        expect(result.value.bids[0].price.value).toBe(0.52);
        expect(result.value.bids[0].quantity.value).toBe(100);
      }
    });

    it('должен сериализовать Orderbook в JSON и восстановить', () => {
      const originalResult = Orderbook.create('market-rt', 'token-market-rt', {
        bids: [
          createLevel(0.50, 300),
          createLevel(0.49, 400),
        ],
        asks: [
          createLevel(0.51, 350),
        ],
        timestamp: new Date('2024-01-15T14:00:00Z'),
      });

      expect(originalResult.ok).toBe(true);
      if (!originalResult.ok) return;

      const json = originalResult.value.toJSON();
      const restoredResult = Orderbook.fromJSON(json);

      expect(restoredResult.ok).toBe(true);
      if (restoredResult.ok) {
        expect(restoredResult.value.marketId).toBe(originalResult.value.marketId);
        expect(restoredResult.value.bids.length).toBe(originalResult.value.bids.length);
        expect(restoredResult.value.asks.length).toBe(originalResult.value.asks.length);
      }
    });

    it('должен вернуть ошибку если JSON невалидный', () => {
      const result = Orderbook.fromJSON({ marketId: 123 } as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderbookValidationError);
      }
    });

    it('должен вернуть ошибку если price в bid невалидный', () => {
      const json = {
        marketId: 'market-bad',
        tokenId: 'token-market-bad',
        bids: [{ price: 'invalid', quantity: 100 }],
        asks: [],
      };

      const result = Orderbook.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderbookValidationError);
        expect(result.error.message).toContain('price');
      }
    });
  });

  describe('Orderbook best bid/ask', () => {
    it('getBestBid() должен вернуть лучший bid', () => {
      const result = Orderbook.create('market-bb', 'token-market-bb', {
        bids: [
          createLevel(0.52, 100),
          createLevel(0.51, 200),
        ],
        asks: [],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const bestBid = result.value.getBestBid();
        expect(bestBid?.value).toBe(0.52);
      }
    });

    it('getBestBid() должен вернуть null если нет бидов', () => {
      const result = Orderbook.create('market-empty', 'token-market-empty', {
        bids: [],
        asks: [createLevel(0.53, 100)],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getBestBid()).toBeNull();
      }
    });

    it('getBestAsk() должен вернуть лучший ask', () => {
      const result = Orderbook.create('market-ba', 'token-market-ba', {
        bids: [],
        asks: [
          createLevel(0.53, 150),
          createLevel(0.54, 250),
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const bestAsk = result.value.getBestAsk();
        expect(bestAsk?.value).toBe(0.53);
      }
    });

    it('getBestAsk() должен вернуть null если нет асков', () => {
      const result = Orderbook.create('market-empty', 'token-market-empty', {
        bids: [createLevel(0.52, 100)],
        asks: [],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getBestAsk()).toBeNull();
      }
    });
  });

  describe('Orderbook цены', () => {
    it('getSpread() должен вернуть Spread объект', () => {
      const result = Orderbook.create('market-spread', 'token-market-spread', {
        bids: [createLevel(0.50, 100)],
        asks: [createLevel(0.52, 100)],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const spread = result.value.getSpread();
        expect(spread).not.toBeNull();
        expect(spread?.width()).toBeCloseTo(0.02, 5);
      }
    });

    it('getSpread() должен вернуть null если нет bid или ask', () => {
      const result1 = Orderbook.create('market-1', 'token-market-1', {
        bids: [createLevel(0.50, 100)],
        asks: [],
      });

      const result2 = Orderbook.create('market-2', 'token-market-2', {
        bids: [],
        asks: [createLevel(0.52, 100)],
      });

      expect(result1.ok && result1.value.getSpread()).toBeNull();
      expect(result2.ok && result2.value.getSpread()).toBeNull();
    });

    it('getMidPrice() должен вернуть среднюю цену', () => {
      const result = Orderbook.create('market-mid', 'token-market-mid', {
        bids: [createLevel(0.50, 100)],
        asks: [createLevel(0.52, 100)],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const midPrice = result.value.getMidPrice();
        expect(midPrice?.value).toBeCloseTo(0.51, 5);
      }
    });

    it('getMicroprice() должен вернуть взвешенную цену', () => {
      const result = Orderbook.create('market-micro', 'token-market-micro', {
        bids: [createLevel(0.50, 100)], // bid qty = 100
        asks: [createLevel(0.52, 200)], // ask qty = 200
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const microprice = result.value.getMicroprice();
        // microprice = (0.52 * 100 + 0.50 * 200) / (100 + 200)
        //             = (52 + 100) / 300 = 0.5067
        expect(microprice?.value).toBeCloseTo(0.5067, 4);
      }
    });

    it('getMicroprice() должен вернуть null если нет bid или ask', () => {
      const result = Orderbook.empty('market-empty', 'token-market-empty');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getMicroprice()).toBeNull();
      }
    });
  });

  describe('Orderbook объёмы', () => {
    it('getTotalBidVolume() должен вернуть сумму всех бидов', () => {
      const result = Orderbook.create('market-vol', 'token-market-vol', {
        bids: [
          createLevel(0.52, 100),
          createLevel(0.51, 200),
          createLevel(0.50, 150),
        ],
        asks: [],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const totalVol = result.value.getTotalBidVolume();
        expect(totalVol.value).toBe(450); // 100 + 200 + 150
      }
    });

    it('getTotalBidVolume(N) должен вернуть сумму первых N уровней', () => {
      const result = Orderbook.create('market-vol', 'token-market-vol', {
        bids: [
          createLevel(0.52, 100),
          createLevel(0.51, 200),
          createLevel(0.50, 150),
        ],
        asks: [],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const topTwoVol = result.value.getTotalBidVolume(2);
        expect(topTwoVol.value).toBe(300); // 100 + 200
      }
    });

    it('getTotalAskVolume() должен вернуть сумму всех асков', () => {
      const result = Orderbook.create('market-vol', 'token-market-vol', {
        bids: [],
        asks: [
          createLevel(0.53, 150),
          createLevel(0.54, 250),
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const totalVol = result.value.getTotalAskVolume();
        expect(totalVol.value).toBe(400); // 150 + 250
      }
    });

    it('getTotalAskVolume(N) должен вернуть сумму первых N уровней', () => {
      const result = Orderbook.create('market-vol', 'token-market-vol', {
        bids: [],
        asks: [
          createLevel(0.53, 150),
          createLevel(0.54, 250),
          createLevel(0.55, 100),
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const topOneVol = result.value.getTotalAskVolume(1);
        expect(topOneVol.value).toBe(150);
      }
    });
  });

  describe('Orderbook imbalance', () => {
    it('getImbalance() должен вернуть положительное значение если больше бидов', () => {
      const result = Orderbook.create('market-imb', 'token-market-imb', {
        bids: [createLevel(0.50, 300)], // bid vol = 300
        asks: [createLevel(0.51, 100)], // ask vol = 100
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const imbalance = result.value.getImbalance(1);
        // (300 - 100) / (300 + 100) = 200 / 400 = 0.5
        expect(imbalance).toBeCloseTo(0.5, 5);
      }
    });

    it('getImbalance() должен вернуть отрицательное значение если больше асков', () => {
      const result = Orderbook.create('market-imb', 'token-market-imb', {
        bids: [createLevel(0.50, 100)], // bid vol = 100
        asks: [createLevel(0.51, 300)], // ask vol = 300
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const imbalance = result.value.getImbalance(1);
        // (100 - 300) / (100 + 300) = -200 / 400 = -0.5
        expect(imbalance).toBeCloseTo(-0.5, 5);
      }
    });

    it('getImbalance() должен вернуть 0 если объёмы равны', () => {
      const result = Orderbook.create('market-balanced', 'token-market-balanced', {
        bids: [createLevel(0.50, 200)],
        asks: [createLevel(0.51, 200)],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const imbalance = result.value.getImbalance(1);
        expect(imbalance).toBe(0);
      }
    });

    it('getImbalance() должен вернуть 0 если нет уровней', () => {
      const result = Orderbook.empty('market-empty', 'token-market-empty');

      expect(result.ok).toBe(true);
      if (result.ok) {
        const imbalance = result.value.getImbalance();
        expect(imbalance).toBe(0);
      }
    });
  });

  describe('Orderbook предикаты', () => {
    it('isEmpty() должен вернуть true если нет бидов и асков', () => {
      const result = Orderbook.empty('market-empty', 'token-market-empty');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isEmpty()).toBe(true);
      }
    });

    it('isEmpty() должен вернуть false если есть уровни', () => {
      const result = Orderbook.create('market-filled', 'token-market-filled', {
        bids: [createLevel(0.50, 100)],
        asks: [],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isEmpty()).toBe(false);
      }
    });

    it('hasLiquidity() должен вернуть true если есть bid и ask', () => {
      const result = Orderbook.create('market-liq', 'token-market-liq', {
        bids: [createLevel(0.50, 100)],
        asks: [createLevel(0.51, 100)],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasLiquidity()).toBe(true);
      }
    });

    it('hasLiquidity() должен вернуть false если нет bid или ask', () => {
      const result1 = Orderbook.create('market-1', 'token-market-1', {
        bids: [createLevel(0.50, 100)],
        asks: [],
      });

      const result2 = Orderbook.empty('market-2', 'token-market-2');

      expect(result1.ok && result1.value.hasLiquidity()).toBe(false);
      expect(result2.ok && result2.value.hasLiquidity()).toBe(false);
    });
  });

  describe('Orderbook глубина', () => {
    it('getBidDepth() должен вернуть количество bid уровней', () => {
      const result = Orderbook.create('market-depth', 'token-market-depth', {
        bids: [
          createLevel(0.52, 100),
          createLevel(0.51, 200),
          createLevel(0.50, 150),
        ],
        asks: [],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getBidDepth()).toBe(3);
      }
    });

    it('getAskDepth() должен вернуть количество ask уровней', () => {
      const result = Orderbook.create('market-depth', 'token-market-depth', {
        bids: [],
        asks: [
          createLevel(0.53, 150),
          createLevel(0.54, 250),
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getAskDepth()).toBe(2);
      }
    });
  });

  describe('Orderbook возраст', () => {
    it('getAgeMs() должен вернуть возраст в миллисекундах', (done) => {
      const result = Orderbook.create('market-age', 'token-market-age', {
        bids: [createLevel(0.50, 100)],
        asks: [createLevel(0.51, 100)],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Подождём 100ms
      setTimeout(() => {
        const ageMs = result.value.getAgeMs();
        expect(ageMs).toBeGreaterThanOrEqual(100);
        expect(ageMs).toBeLessThan(200);
        done();
      }, 100);
    });

    it('isStale() должен вернуть true если старше maxAgeMs', (done) => {
      const result = Orderbook.create('market-stale', 'token-market-stale', {
        bids: [createLevel(0.50, 100)],
        asks: [createLevel(0.51, 100)],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Подождём 150ms, проверим с maxAge=100ms
      setTimeout(() => {
        expect(result.value.isStale(100)).toBe(true);
        expect(result.value.isStale(200)).toBe(false);
        done();
      }, 150);
    });
  });

  describe('Orderbook утилиты', () => {
    it('toString() должен вернуть читаемую строку', () => {
      const result = Orderbook.create('market-str', 'token-market-str', {
        bids: [
          createLevel(0.52, 100),
          createLevel(0.51, 200),
        ],
        asks: [
          createLevel(0.53, 150),
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const str = result.value.toString();
        expect(str).toContain('market-str');
        expect(str).toContain('2 bids');
        expect(str).toContain('1 asks');
        expect(str).toContain('spread');
      }
    });

    it('toObject() должен вернуть объект с метриками', () => {
      const result = Orderbook.create('market-obj', 'token-market-obj', {
        bids: [createLevel(0.50, 100)],
        asks: [createLevel(0.52, 100)],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const obj = result.value.toObject();
        expect(obj.marketId).toBe('market-obj');
        expect(obj.bestBid).toBe(0.50);
        expect(obj.bestAsk).toBe(0.52);
        expect(obj.midPrice).toBeCloseTo(0.51, 5);
        expect(obj.spreadWidth).toBeCloseTo(0.02, 5);
        expect(obj.bidDepth).toBe(1);
        expect(obj.askDepth).toBe(1);
      }
    });
  });
});
