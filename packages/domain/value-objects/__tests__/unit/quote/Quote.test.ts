import { describe, it, expect } from '@jest/globals';
import { Quote, QuoteInvariantViolation } from '../../../src/quote/core/index.js';
import { Price } from '../../../src/price/core/Price.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';

describe('Quote Core', () => {
  describe('of()', () => {
    it('создаёт двустороннюю котировку', () => {
      const bid = Price.of(0.48);
      const ask = Price.of(0.52);
      const bidSize = Quantity.of(100);
      const askSize = Quantity.of(150);
      const timestamp = Date.now();

      const quote = Quote.of(bid, ask, bidSize, askSize, timestamp);

      expect(quote.bid()).toBe(bid);
      expect(quote.ask()).toBe(ask);
      expect(quote.bidSize()).toBe(bidSize);
      expect(quote.askSize()).toBe(askSize);
      expect(quote.timestampMs()).toBe(timestamp);
    });

    it('создаёт одностороннюю bid котировку', () => {
      const bid = Price.of(0.50);
      const bidSize = Quantity.of(100);
      const askSize = Quantity.ZERO;
      const timestamp = Date.now();

      const quote = Quote.of(bid, null, bidSize, askSize, timestamp);

      expect(quote.bid()).toBe(bid);
      expect(quote.ask()).toBeNull();
      expect(quote.bidSize()).toBe(bidSize);
      expect(quote.askSize()).toBe(askSize);
    });

    it('создаёт одностороннюю ask котировку', () => {
      const ask = Price.of(0.51);
      const bidSize = Quantity.ZERO;
      const askSize = Quantity.of(200);
      const timestamp = Date.now();

      const quote = Quote.of(null, ask, bidSize, askSize, timestamp);

      expect(quote.bid()).toBeNull();
      expect(quote.ask()).toBe(ask);
      expect(quote.bidSize()).toBe(bidSize);
      expect(quote.askSize()).toBe(askSize);
    });

    it('принимает Date объект как timestamp', () => {
      const bid = Price.of(0.48);
      const ask = Price.of(0.52);
      const bidSize = Quantity.of(100);
      const askSize = Quantity.of(150);
      const date = new Date('2024-01-28T12:00:00.000Z');

      const quote = Quote.of(bid, ask, bidSize, askSize, date);

      expect(quote.timestampMs()).toBe(date.getTime());
    });

    it('бросает QuoteInvariantViolation когда обе стороны null', () => {
      const bidSize = Quantity.ZERO;
      const askSize = Quantity.ZERO;
      const timestamp = Date.now();

      expect(() => {
        Quote.of(null, null, bidSize, askSize, timestamp);
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(null, null, bidSize, askSize, timestamp);
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteInvariantViolation);
        expect((error as QuoteInvariantViolation).reason).toBe('BOTH_SIDES_NULL');
      }
    });

    it('бросает QuoteInvariantViolation когда bid > ask', () => {
      const bid = Price.of(0.60);
      const ask = Price.of(0.40); // bid > ask
      const bidSize = Quantity.of(100);
      const askSize = Quantity.of(150);
      const timestamp = Date.now();

      expect(() => {
        Quote.of(bid, ask, bidSize, askSize, timestamp);
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(bid, ask, bidSize, askSize, timestamp);
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteInvariantViolation);
        expect((error as QuoteInvariantViolation).reason).toBe('BID_GREATER_THAN_ASK');
      }
    });

    it('разрешает bid === ask', () => {
      const bid = Price.of(0.50);
      const ask = Price.of(0.50);
      const bidSize = Quantity.of(100);
      const askSize = Quantity.of(150);
      const timestamp = Date.now();

      const quote = Quote.of(bid, ask, bidSize, askSize, timestamp);

      expect(quote.bid()!.equals(quote.ask()!)).toBe(true);
    });
  });

  describe('getTimestamp()', () => {
    it('возвращает новый Date объект', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const date1 = quote.getTimestamp();
      const date2 = quote.getTimestamp();

      expect(date1).toEqual(date2);
      expect(date1).not.toBe(date2); // Разные объекты
    });

    it('изменение Date не влияет на Quote (immutability)', () => {
      const timestamp = Date.now();
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        timestamp
      );

      const date = quote.getTimestamp();
      date.setFullYear(2050);

      expect(quote.timestampMs()).toBe(timestamp);
      expect(quote.getTimestamp().getFullYear()).not.toBe(2050);
    });
  });

  describe('isTwoSided()', () => {
    it('возвращает true для двусторонней котировки', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      expect(quote.isTwoSided()).toBe(true);
    });

    it('возвращает false для bid-only котировки', () => {
      const quote = Quote.of(
        Price.of(0.50),
        null,
        Quantity.of(100),
        Quantity.ZERO,
        Date.now()
      );

      expect(quote.isTwoSided()).toBe(false);
    });

    it('возвращает false для ask-only котировки', () => {
      const quote = Quote.of(
        null,
        Price.of(0.51),
        Quantity.ZERO,
        Quantity.of(200),
        Date.now()
      );

      expect(quote.isTwoSided()).toBe(false);
    });
  });

  describe('hasBid() и hasAsk()', () => {
    it('hasBid() возвращает true когда bid определён', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      expect(quote.hasBid()).toBe(true);
    });

    it('hasBid() возвращает false когда bid null', () => {
      const quote = Quote.of(
        null,
        Price.of(0.51),
        Quantity.ZERO,
        Quantity.of(200),
        Date.now()
      );

      expect(quote.hasBid()).toBe(false);
    });

    it('hasAsk() возвращает true когда ask определён', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      expect(quote.hasAsk()).toBe(true);
    });

    it('hasAsk() возвращает false когда ask null', () => {
      const quote = Quote.of(
        Price.of(0.50),
        null,
        Quantity.of(100),
        Quantity.ZERO,
        Date.now()
      );

      expect(quote.hasAsk()).toBe(false);
    });
  });

  describe('spreadWidth()', () => {
    it('вычисляет spread для двусторонней котировки', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const spread = quote.spreadWidth();

      expect(spread).not.toBeNull();
      expect(spread!.toNumber()).toBe(0.04);
    });

    it('возвращает null для bid-only котировки', () => {
      const quote = Quote.of(
        Price.of(0.50),
        null,
        Quantity.of(100),
        Quantity.ZERO,
        Date.now()
      );

      expect(quote.spreadWidth()).toBeNull();
    });

    it('возвращает null для ask-only котировки', () => {
      const quote = Quote.of(
        null,
        Price.of(0.51),
        Quantity.ZERO,
        Quantity.of(200),
        Date.now()
      );

      expect(quote.spreadWidth()).toBeNull();
    });

    it('возвращает 0 когда bid === ask', () => {
      const quote = Quote.of(
        Price.of(0.50),
        Price.of(0.50),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const spread = quote.spreadWidth();

      expect(spread).not.toBeNull();
      expect(spread!.toNumber()).toBe(0);
    });
  });

  describe('midPrice()', () => {
    it('вычисляет mid-price для двусторонней котировки', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const mid = quote.midPrice();

      expect(mid).not.toBeNull();
      expect(mid!.value().toNumber()).toBe(0.50);
    });

    it('возвращает null для bid-only котировки', () => {
      const quote = Quote.of(
        Price.of(0.50),
        null,
        Quantity.of(100),
        Quantity.ZERO,
        Date.now()
      );

      expect(quote.midPrice()).toBeNull();
    });

    it('возвращает null для ask-only котировки', () => {
      const quote = Quote.of(
        null,
        Price.of(0.51),
        Quantity.ZERO,
        Quantity.of(200),
        Date.now()
      );

      expect(quote.midPrice()).toBeNull();
    });
  });

  describe('spreadPercentage()', () => {
    it('вычисляет spread в процентах', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const spreadPct = quote.spreadPercentage();

      expect(spreadPct).not.toBeNull();
      expect(spreadPct!.toNumber()).toBeCloseTo(8.0, 1); // (0.04 / 0.50) * 100 = 8%
    });

    it('возвращает null для односторонней котировки', () => {
      const quote = Quote.of(
        Price.of(0.50),
        null,
        Quantity.of(100),
        Quantity.ZERO,
        Date.now()
      );

      expect(quote.spreadPercentage()).toBeNull();
    });

    it('возвращает 0 когда mid === 0 (защита от деления на ноль)', () => {
      // Это edge case который не должен произойти в реальности,
      // но проверяем для полноты
      const quote = Quote.of(
        Price.of(0.0001), // MIN_PRICE
        Price.of(0.0001),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const spreadPct = quote.spreadPercentage();

      expect(spreadPct).not.toBeNull();
      expect(spreadPct!.toNumber()).toBe(0);
    });
  });

  describe('crossesMarket()', () => {
    it('определяет crossing когда bid >= orderbook ask', () => {
      const quote = Quote.of(
        Price.of(0.51), // наш bid
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51); // наш bid >= orderbook ask

      expect(quote.crossesMarket(orderbookBid, orderbookAsk)).toBe(true);
    });

    it('определяет crossing когда ask <= orderbook bid', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.50), // наш ask
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50); // наш ask <= orderbook bid
      const orderbookAsk = Price.of(0.51);

      expect(quote.crossesMarket(orderbookBid, orderbookAsk)).toBe(true);
    });

    it('не определяет crossing для нормальной котировки', () => {
      const quote = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      expect(quote.crossesMarket(orderbookBid, orderbookAsk)).toBe(false);
    });

    it('возвращает false когда наш bid null', () => {
      const quote = Quote.of(
        null, // bid null
        Price.of(0.52),
        Quantity.ZERO,
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50);
      const orderbookAsk = Price.of(0.51);

      expect(quote.crossesMarket(orderbookBid, orderbookAsk)).toBe(false);
    });

    it('возвращает false когда orderbook ask null', () => {
      const quote = Quote.of(
        Price.of(0.51),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        Date.now()
      );

      const orderbookBid = Price.of(0.50);

      expect(quote.crossesMarket(orderbookBid, null)).toBe(false);
    });
  });

  describe('equals()', () => {
    it('сравнивает идентичные котировки', () => {
      const timestamp = Date.now();
      const quote1 = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        timestamp
      );

      expect(quote1.equals(quote2)).toBe(true);
    });

    it('различает котировки с разным bid', () => {
      const timestamp = Date.now();
      const quote1 = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(0.49), // другой bid
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        timestamp
      );

      expect(quote1.equals(quote2)).toBe(false);
    });

    it('различает котировки с разным ask', () => {
      const timestamp = Date.now();
      const quote1 = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(0.48),
        Price.of(0.53), // другой ask
        Quantity.of(100),
        Quantity.of(150),
        timestamp
      );

      expect(quote1.equals(quote2)).toBe(false);
    });

    it('различает котировки с разными sizes', () => {
      const timestamp = Date.now();
      const quote1 = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(200), // другой bidSize
        Quantity.of(150),
        timestamp
      );

      expect(quote1.equals(quote2)).toBe(false);
    });

    it('различает котировки с разными timestamp', () => {
      const quote1 = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        1000
      );
      const quote2 = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        2000 // другой timestamp
      );

      expect(quote1.equals(quote2)).toBe(false);
    });

    it('различает one-sided и two-sided котировки', () => {
      const timestamp = Date.now();
      const quote1 = Quote.of(
        Price.of(0.48),
        Price.of(0.52),
        Quantity.of(100),
        Quantity.of(150),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(0.48),
        null, // ask null
        Quantity.of(100),
        Quantity.ZERO,
        timestamp
      );

      expect(quote1.equals(quote2)).toBe(false);
    });
  });
});
