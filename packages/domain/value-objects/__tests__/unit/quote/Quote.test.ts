import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Quote, QuoteInvariantViolation } from '../../../src/quote/core/index.js';
import { Price } from '../../../src/price/core/Price.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';

describe('Quote Core', () => {
  describe('of()', () => {
    it('создаёт двустороннюю котировку', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const bidSize = Quantity.of(new Decimal(100));
      const askSize = Quantity.of(new Decimal(150));
      const timestamp = new Decimal(Date.now());

      const quote = Quote.of(bid, ask, bidSize, askSize, timestamp);

      expect(quote.bid()).toBe(bid);
      expect(quote.ask()).toBe(ask);
      expect(quote.bidSize()).toBe(bidSize);
      expect(quote.askSize()).toBe(askSize);
      expect(quote.timestampMs().toNumber()).toBe(timestamp.toNumber());
    });

    it('создаёт одностороннюю bid котировку', () => {
      const bid = Price.of(new Decimal(0.50));
      const bidSize = Quantity.of(new Decimal(100));
      const askSize = Quantity.ZERO;
      const timestamp = new Decimal(Date.now());

      const quote = Quote.of(bid, null, bidSize, askSize, new Decimal(timestamp));

      expect(quote.bid()).toBe(bid);
      expect(quote.ask()).toBeNull();
      expect(quote.bidSize()).toBe(bidSize);
      expect(quote.askSize()).toBe(askSize);
    });

    it('создаёт одностороннюю ask котировку', () => {
      const ask = Price.of(new Decimal(0.51));
      const bidSize = Quantity.ZERO;
      const askSize = Quantity.of(new Decimal(200));
      const timestamp = new Decimal(Date.now());

      const quote = Quote.of(null, ask, bidSize, askSize, new Decimal(timestamp));

      expect(quote.bid()).toBeNull();
      expect(quote.ask()).toBe(ask);
      expect(quote.bidSize()).toBe(bidSize);
      expect(quote.askSize()).toBe(askSize);
    });

    it('принимает Date объект как timestamp', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const bidSize = Quantity.of(new Decimal(100));
      const askSize = Quantity.of(new Decimal(150));
      const date = new Date('2024-01-28T12:00:00.000Z');

      const quote = Quote.of(bid, ask, bidSize, askSize, new Decimal(date.getTime()));

      expect(quote.timestampMs().toNumber()).toBe(date.getTime());
    });

    it('бросает QuoteInvariantViolation когда обе стороны null', () => {
      const bidSize = Quantity.ZERO;
      const askSize = Quantity.ZERO;
      const timestamp = new Decimal(Date.now());

      expect(() => {
        Quote.of(null, null, bidSize, askSize, new Decimal(timestamp));
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(null, null, bidSize, askSize, new Decimal(timestamp));
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteInvariantViolation);
        expect((error as QuoteInvariantViolation).reason).toBe('BOTH_SIDES_NULL');
      }
    });

    it('бросает QuoteInvariantViolation когда bid > ask', () => {
      const bid = Price.of(new Decimal(0.60));
      const ask = Price.of(new Decimal(0.40)); // bid > ask
      const bidSize = Quantity.of(new Decimal(100));
      const askSize = Quantity.of(new Decimal(150));
      const timestamp = new Decimal(Date.now());

      expect(() => {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(timestamp));
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(timestamp));
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteInvariantViolation);
        expect((error as QuoteInvariantViolation).reason).toBe('BID_GREATER_THAN_ASK');
      }
    });

    it('разрешает bid === ask', () => {
      const bid = Price.of(new Decimal(0.50));
      const ask = Price.of(new Decimal(0.50));
      const bidSize = Quantity.of(new Decimal(100));
      const askSize = Quantity.of(new Decimal(150));
      const timestamp = new Decimal(Date.now());

      const quote = Quote.of(bid, ask, bidSize, askSize, new Decimal(timestamp));

      expect(quote.bid()!.equals(quote.ask()!)).toBe(true);
    });
  });

  describe('timestamp validation', () => {
    const bid = Price.of(new Decimal(0.48));
    const ask = Price.of(new Decimal(0.52));
    const bidSize = Quantity.of(new Decimal(100));
    const askSize = Quantity.of(new Decimal(150));

    it('бросает INVALID_TIMESTAMP для NaN', () => {
      expect(() => {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(NaN));
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(NaN));
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteInvariantViolation);
        expect((error as QuoteInvariantViolation).reason).toBe('INVALID_TIMESTAMP');
      }
    });

    it('бросает INVALID_TIMESTAMP для Infinity', () => {
      expect(() => {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(Infinity));
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(Infinity));
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteInvariantViolation);
        expect((error as QuoteInvariantViolation).reason).toBe('INVALID_TIMESTAMP');
      }
    });

    it('бросает INVALID_TIMESTAMP для отрицательного значения', () => {
      expect(() => {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(-1000));
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(-1000));
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteInvariantViolation);
        expect((error as QuoteInvariantViolation).reason).toBe('INVALID_TIMESTAMP');
      }
    });

    it('бросает INVALID_TIMESTAMP для дробного числа', () => {
      expect(() => {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(1234.567));
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(1234.567));
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteInvariantViolation);
        expect((error as QuoteInvariantViolation).reason).toBe('INVALID_TIMESTAMP');
      }
    });

    it('бросает INVALID_TIMESTAMP для слишком большого значения', () => {
      const tooLarge = 10000000000000; // > 9999999999999

      expect(() => {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(tooLarge));
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(bid, ask, bidSize, askSize, new Decimal(tooLarge));
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteInvariantViolation);
        expect((error as QuoteInvariantViolation).reason).toBe('INVALID_TIMESTAMP');
      }
    });

    it('принимает валидный Unix timestamp (0)', () => {
      const quote = Quote.of(bid, ask, bidSize, askSize, new Decimal(0));
      expect(quote.timestampMs().toNumber()).toBe(0);
    });

    it('принимает валидный Unix timestamp (максимум)', () => {
      const maxTimestamp = 9999999999999;
      const quote = Quote.of(bid, ask, bidSize, askSize, new Decimal(maxTimestamp));
      expect(quote.timestampMs().toNumber()).toBe(maxTimestamp);
    });

    it('принимает текущий Unix timestamp', () => {
      const now = new Decimal(Date.now());
      const quote = Quote.of(bid, ask, bidSize, askSize, now);
      expect(quote.timestampMs().toNumber()).toBe(now.toNumber());
    });
  });

  describe('size consistency invariant', () => {
    it('бросает INCONSISTENT_BID_SIZE когда bid=null но bidSize>0', () => {
      expect(() => {
        Quote.of(
          null,  // bid отсутствует
          Price.of(new Decimal(0.52)),
          Quantity.of(new Decimal(100)),  // но bidSize = 100 - АБСУРД!
          Quantity.of(new Decimal(150)),
          new Decimal(Date.now())
        );
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(
          null,
          Price.of(new Decimal(0.52)),
          Quantity.of(new Decimal(100)),
          Quantity.of(new Decimal(150)),
          new Decimal(Date.now())
        );
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteInvariantViolation);
        expect((error as QuoteInvariantViolation).reason).toBe('INCONSISTENT_BID_SIZE');
      }
    });

    it('бросает INCONSISTENT_ASK_SIZE когда ask=null но askSize>0', () => {
      expect(() => {
        Quote.of(
          Price.of(new Decimal(0.48)),
          null,  // ask отсутствует
          Quantity.of(new Decimal(100)),
          Quantity.of(new Decimal(150)),  // но askSize = 150 - АБСУРД!
          new Decimal(Date.now())
        );
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(
          Price.of(new Decimal(0.48)),
          null,
          Quantity.of(new Decimal(100)),
          Quantity.of(new Decimal(150)),
          new Decimal(Date.now())
        );
      } catch (error) {
        expect(error).toBeInstanceOf(QuoteInvariantViolation);
        expect((error as QuoteInvariantViolation).reason).toBe('INCONSISTENT_ASK_SIZE');
      }
    });

    it('разрешает bid=null с bidSize=0', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.52)),
        Quantity.ZERO,  // ✅ OK: bid=null → bidSize=0
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      expect(quote.bid()).toBeNull();
      expect(quote.bidSize().value().toNumber()).toBe(0);
    });

    it('разрешает ask=null с askSize=0', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,  // ✅ OK: ask=null → askSize=0
        new Decimal(Date.now())
      );

      expect(quote.ask()).toBeNull();
      expect(quote.askSize().value().toNumber()).toBe(0);
    });
  });

  describe('getTimestamp()', () => {
    it('возвращает новый Date объект', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const date1 = quote.getTimestamp();
      const date2 = quote.getTimestamp();

      expect(date1).toEqual(date2);
      expect(date1).not.toBe(date2); // Разные объекты
    });

    it('изменение Date не влияет на Quote (immutability)', () => {
      const timestamp = new Decimal(Date.now());
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );

      const date = quote.getTimestamp();
      date.setFullYear(2050);

      expect(quote.timestampMs().toNumber()).toBe(timestamp.toNumber());
      expect(quote.getTimestamp().getFullYear()).not.toBe(2050);
    });
  });

  describe('age()', () => {
    it('вычисляет возраст котировки в миллисекундах', () => {
      const timestamp = new Decimal(Date.now() - 5000); // 5 секунд назад
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );

      const now = new Decimal(Date.now());
      const age = quote.age(now);

      expect(age.toNumber()).toBeGreaterThanOrEqual(5000);
      expect(age.toNumber()).toBeLessThan(6000); // с учетом времени выполнения
    });

    it('возвращает 0 для текущего момента', () => {
      const now = new Decimal(Date.now());
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        now
      );

      const age = quote.age(now);
      expect(age.toNumber()).toBe(0);
    });

    it('возвращает отрицательное значение для будущего timestamp', () => {
      const futureTimestamp = new Decimal(Date.now() + 10000); // 10 секунд в будущем
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        futureTimestamp
      );

      const now = new Decimal(Date.now());
      const age = quote.age(now);

      expect(age.toNumber()).toBeLessThan(0);
      expect(age.toNumber()).toBeGreaterThan(-11000);
    });

    it('полезен для проверок устаревания', () => {
      const oldTimestamp = new Decimal(Date.now() - 15000); // 15 секунд назад
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        oldTimestamp
      );

      const MAX_AGE_MS = 10000; // 10 секунд
      const isStale = quote.age(new Decimal(Date.now())).greaterThan(MAX_AGE_MS);

      expect(isStale).toBe(true);
    });

    it('принимает Date объект', () => {
      const timestamp = new Decimal(Date.now() - 5000);
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );

      const now = new Date();
      const age = quote.age(new Decimal(now.getTime()));

      expect(age.toNumber()).toBeGreaterThanOrEqual(5000);
      expect(age.toNumber()).toBeLessThan(6000);
    });

    it('принимает строку с Unix ms', () => {
      const timestamp = new Decimal(Date.now() - 5000);
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );

      const now = new Decimal(Date.now());
      const age = quote.age(now);

      expect(age.toNumber()).toBeGreaterThanOrEqual(5000);
      expect(age.toNumber()).toBeLessThan(6000);
    });

    it('принимает Decimal', () => {
      const timestamp = new Decimal(Date.now() - 5000);
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );

      const now = new Decimal(Date.now());
      const age = quote.age(now);

      expect(age.toNumber()).toBeGreaterThanOrEqual(5000);
      expect(age.toNumber()).toBeLessThan(6000);
    });
  });

  describe('isTwoSided()', () => {
    it('возвращает true для двусторонней котировки', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      expect(quote.isTwoSided()).toBe(true);
    });

    it('возвращает false для bid-only котировки', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        new Decimal(Date.now())
      );

      expect(quote.isTwoSided()).toBe(false);
    });

    it('возвращает false для ask-only котировки', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.ZERO,
        Quantity.of(new Decimal(200)),
        new Decimal(Date.now())
      );

      expect(quote.isTwoSided()).toBe(false);
    });
  });

  describe('hasBid() и hasAsk()', () => {
    it('hasBid() возвращает true когда bid определён', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      expect(quote.hasBid()).toBe(true);
    });

    it('hasBid() возвращает false когда bid null', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.ZERO,
        Quantity.of(new Decimal(200)),
        new Decimal(Date.now())
      );

      expect(quote.hasBid()).toBe(false);
    });

    it('hasAsk() возвращает true когда ask определён', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      expect(quote.hasAsk()).toBe(true);
    });

    it('hasAsk() возвращает false когда ask null', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        new Decimal(Date.now())
      );

      expect(quote.hasAsk()).toBe(false);
    });
  });

  describe('spread()', () => {
    it('создает Spread объект для двусторонней котировки', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const spread = quote.spread();

      expect(spread).not.toBeNull();
      expect(spread!.width().toNumber()).toBe(0.04);
      expect(spread!.mid().toNumber()).toBe(0.50);
      expect(spread!.widthPercentage().toNumber()).toBeCloseTo(8.0, 1);
    });

    it('возвращает null для bid-only котировки', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        new Decimal(Date.now())
      );

      expect(quote.spread()).toBeNull();
    });

    it('возвращает null для ask-only котировки', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.ZERO,
        Quantity.of(new Decimal(200)),
        new Decimal(Date.now())
      );

      expect(quote.spread()).toBeNull();
    });

    it('возвращает Spread с нулевой шириной когда bid === ask', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        Price.of(new Decimal(0.50)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const spread = quote.spread();

      expect(spread).not.toBeNull();
      expect(spread!.width().toNumber()).toBe(0);
      expect(spread!.isZeroWidth()).toBe(true);
    });
  });

  describe('equals()', () => {
    it('сравнивает идентичные котировки', () => {
      const timestamp = new Decimal(Date.now());
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );

      expect(quote1.equals(quote2)).toBe(true);
    });

    it('различает котировки с разным bid', () => {
      const timestamp = new Decimal(Date.now());
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(new Decimal(0.49)), // другой bid
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );

      expect(quote1.equals(quote2)).toBe(false);
    });

    it('различает котировки с разным ask', () => {
      const timestamp = new Decimal(Date.now());
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.53)), // другой ask
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );

      expect(quote1.equals(quote2)).toBe(false);
    });

    it('различает котировки с разными sizes', () => {
      const timestamp = new Decimal(Date.now());
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(200)), // другой bidSize
        Quantity.of(new Decimal(150)),
        timestamp
      );

      expect(quote1.equals(quote2)).toBe(false);
    });

    it('НЕ различает котировки с разными timestamp (только рыночные данные)', () => {
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(1000)      );
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(2000) // другой timestamp
      );

      // equals() сравнивает только рыночные данные, timestamp игнорируется
      expect(quote1.equals(quote2)).toBe(true);
    });

    it('различает one-sided и two-sided котировки', () => {
      const timestamp = new Decimal(Date.now());
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        null, // ask null
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        timestamp
      );

      expect(quote1.equals(quote2)).toBe(false);
    });
  });

  describe('equalsWithTimestamp()', () => {
    it('сравнивает полностью идентичные котировки включая timestamp', () => {
      const timestamp = new Decimal(Date.now());
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );

      expect(quote1.equalsWithTimestamp(quote2)).toBe(true);
    });

    it('различает котировки с одинаковыми данными но разным timestamp', () => {
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(1000)      );
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(2000) // другой timestamp
      );

      // equals() возвращает true (только рыночные данные)
      expect(quote1.equals(quote2)).toBe(true);

      // equalsWithTimestamp() возвращает false (timestamp отличается)
      expect(quote1.equalsWithTimestamp(quote2)).toBe(false);
    });

    it('различает котировки с разным bid', () => {
      const timestamp = new Decimal(Date.now());
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(new Decimal(0.49)), // другой bid
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );

      expect(quote1.equalsWithTimestamp(quote2)).toBe(false);
    });

    it('различает котировки с разными sizes', () => {
      const timestamp = new Decimal(Date.now());
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      );
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(200)), // другой bidSize
        Quantity.of(new Decimal(150)),
        timestamp
      );

      expect(quote1.equalsWithTimestamp(quote2)).toBe(false);
    });

    it('различает one-sided котировки с одинаковым timestamp', () => {
      const timestamp = new Decimal(Date.now());
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        timestamp
      );
      const quote2 = Quote.of(
        null,
        Price.of(new Decimal(0.52)),
        Quantity.ZERO,
        Quantity.of(new Decimal(150)),
        timestamp
      );

      expect(quote1.equalsWithTimestamp(quote2)).toBe(false);
    });
  });
});
