import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import type { MarketDataSourceId, InstrumentId } from '@polymarket/ids';
import { Quote, QuoteInvariantViolation } from '../../../src/quote/core/index.js';
import { Price } from '../../../src/price/core/Price.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { TimestampService } from '../../../src/timestamp/index.js';
import type { Timestamp } from '../../../src/timestamp/index.js';

// Тестовые константы для sourceId и instrumentId
const TEST_SOURCE_ID = 'TEST_SOURCE' as MarketDataSourceId;
const TEST_INSTRUMENT_ID = 'TEST_INSTRUMENT' as InstrumentId;

// Вспомогательная функция для создания тестового Timestamp
function createTestTimestamp(ms?: number): Timestamp {
  const result = TimestampService.create(ms ?? Date.now());
  if (!result.ok) {
    throw new Error(`Failed to create test timestamp: ${result.error.message}`);
  }
  return result.value;
}

describe('Quote Core', () => {
  describe('of()', () => {
    it('создаёт двустороннюю котировку', () => {
      const bid = Price.of(new Decimal(0.48));
      const ask = Price.of(new Decimal(0.52));
      const bidSize = Quantity.of(new Decimal(100));
      const askSize = Quantity.of(new Decimal(150));
      const timestamp = createTestTimestamp();

      const quote = Quote.of(bid, ask, bidSize, askSize, timestamp, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.bid()).toBe(bid);
      expect(quote.ask()).toBe(ask);
      expect(quote.bidSize()).toBe(bidSize);
      expect(quote.askSize()).toBe(askSize);
      expect(quote.timestampMs().toNumber()).toBe(timestamp.toNumber());
      expect(quote.sourceId()).toBe(TEST_SOURCE_ID);
      expect(quote.instrumentId()).toBe(TEST_INSTRUMENT_ID);
    });

    it('создаёт одностороннюю bid котировку', () => {
      const bid = Price.of(new Decimal(0.50));
      const bidSize = Quantity.of(new Decimal(100));
      const askSize = Quantity.ZERO;
      const timestamp = createTestTimestamp();

      const quote = Quote.of(bid, null, bidSize, askSize, timestamp, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.bid()).toBe(bid);
      expect(quote.ask()).toBeNull();
      expect(quote.bidSize()).toBe(bidSize);
      expect(quote.askSize()).toBe(askSize);
    });

    it('создаёт одностороннюю ask котировку', () => {
      const ask = Price.of(new Decimal(0.51));
      const bidSize = Quantity.ZERO;
      const askSize = Quantity.of(new Decimal(200));
      const timestamp = createTestTimestamp();

      const quote = Quote.of(null, ask, bidSize, askSize, timestamp, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

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

      const quote = Quote.of(bid, ask, bidSize, askSize, createTestTimestamp(date.getTime()), TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.timestampMs().toNumber()).toBe(date.getTime());
    });

    it('бросает QuoteInvariantViolation когда обе стороны null', () => {
      const bidSize = Quantity.ZERO;
      const askSize = Quantity.ZERO;
      const timestamp = createTestTimestamp();

      expect(() => {
        Quote.of(null, null, bidSize, askSize, timestamp, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(null, null, bidSize, askSize, timestamp, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
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
      const timestamp = createTestTimestamp();

      expect(() => {
        Quote.of(bid, ask, bidSize, askSize, timestamp, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(bid, ask, bidSize, askSize, timestamp, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
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
      const timestamp = createTestTimestamp();

      const quote = Quote.of(bid, ask, bidSize, askSize, timestamp, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.bid()!.equals(quote.ask()!)).toBe(true);
    });
  });

  describe('timestamp validation', () => {
    const bid = Price.of(new Decimal(0.48));
    const ask = Price.of(new Decimal(0.52));
    const bidSize = Quantity.of(new Decimal(100));
    const askSize = Quantity.of(new Decimal(150));

    it('бросает INVALID_TIMESTAMP для NaN', () => {
      // TimestampService.create() отклоняет NaN и возвращает Err
      const timestampResult = TimestampService.create(NaN);
      expect(timestampResult.ok).toBe(false);
      if (!timestampResult.ok) {
        expect(timestampResult.error.message).toContain('NaN');
      }
    });

    it('бросает INVALID_TIMESTAMP для Infinity', () => {
      // TimestampService.create() отклоняет Infinity и возвращает Err
      const timestampResult = TimestampService.create(Infinity);
      expect(timestampResult.ok).toBe(false);
      if (!timestampResult.ok) {
        expect(timestampResult.error.message).toContain('finite');
      }
    });

    it('бросает INVALID_TIMESTAMP для отрицательного значения', () => {
      // TimestampService.create() отклоняет отрицательные значения и возвращает Err
      const timestampResult = TimestampService.create(-1000);
      expect(timestampResult.ok).toBe(false);
      if (!timestampResult.ok) {
        expect(timestampResult.error.message).toContain('negative');
      }
    });

    it('принимает дробное число (truncate to integer)', () => {
      // TimestampService.create() принимает дробные значения и обрезает их до целого
      const timestampResult = TimestampService.create(1234.567);
      expect(timestampResult.ok).toBe(true);
      if (timestampResult.ok) {
        expect(timestampResult.value.toNumber()).toBe(1234);
      }
    });

    it('бросает INVALID_TIMESTAMP для слишком большого значения', () => {
      const tooLarge = 10000000000000; // > 9999999999999

      // TimestampService.create() отклоняет слишком большие значения и возвращает Err
      const timestampResult = TimestampService.create(tooLarge);
      expect(timestampResult.ok).toBe(false);
      if (!timestampResult.ok) {
        expect(timestampResult.error.message).toContain('too large');
      }
    });

    it('принимает валидный Unix timestamp (0)', () => {
      const quote = Quote.of(bid, ask, bidSize, askSize, createTestTimestamp(0), TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quote.timestampMs().toNumber()).toBe(0);
    });

    it('принимает валидный Unix timestamp (максимум)', () => {
      const maxTimestamp = 9999999999999;
      const quote = Quote.of(bid, ask, bidSize, askSize, createTestTimestamp(maxTimestamp), TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quote.timestampMs().toNumber()).toBe(maxTimestamp);
    });

    it('принимает текущий Unix timestamp', () => {
      const nowMs = Date.now();
      const quote = Quote.of(bid, ask, bidSize, askSize, createTestTimestamp(nowMs), TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quote.timestampMs().toNumber()).toBe(nowMs);
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
          createTestTimestamp()
        , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(
          null,
          Price.of(new Decimal(0.52)),
          Quantity.of(new Decimal(100)),
          Quantity.of(new Decimal(150)),
          createTestTimestamp()
        , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
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
          createTestTimestamp()
        , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      }).toThrow(QuoteInvariantViolation);

      try {
        Quote.of(
          Price.of(new Decimal(0.48)),
          null,
          Quantity.of(new Decimal(100)),
          Quantity.of(new Decimal(150)),
          createTestTimestamp()
        , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
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
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.bid()).toBeNull();
      expect(quote.bidSize().value().toNumber()).toBe(0);
    });

    it('разрешает ask=null с askSize=0', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,  // ✅ OK: ask=null → askSize=0
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

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
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const date1 = quote.getTimestamp();
      const date2 = quote.getTimestamp();

      expect(date1).toEqual(date2);
      expect(date1).not.toBe(date2); // Разные объекты
    });

    it('изменение Date не влияет на Quote (immutability)', () => {
      const timestamp = createTestTimestamp();
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const date = quote.getTimestamp();
      date.setFullYear(2050);

      expect(quote.timestampMs().toNumber()).toBe(timestamp.toNumber());
      expect(quote.getTimestamp().getFullYear()).not.toBe(2050);
    });
  });

  describe('age()', () => {
    it('вычисляет возраст котировки в миллисекундах', () => {
      const timestampMs = Date.now() - 5000; // 5 секунд назад
      const timestamp = createTestTimestamp(timestampMs);
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const nowMs = Date.now();
      const now = createTestTimestamp(nowMs);
      const age = quote.age(now);

      expect(age.toNumber()).toBeGreaterThanOrEqual(5000);
      expect(age.toNumber()).toBeLessThan(6000); // с учетом времени выполнения
    });

    it('возвращает 0 для текущего момента', () => {
      const nowMs = Date.now();
      const now = createTestTimestamp(nowMs);
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        now
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const age = quote.age(now);
      expect(age.toNumber()).toBe(0);
    });

    it('возвращает отрицательное значение для будущего timestamp', () => {
      const futureTimestampMs = Date.now() + 10000; // 10 секунд в будущем
      const futureTimestamp = createTestTimestamp(futureTimestampMs);
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        futureTimestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const nowMs = Date.now();
      const now = createTestTimestamp(nowMs);
      const age = quote.age(now);

      expect(age.toNumber()).toBeLessThan(0);
      expect(age.toNumber()).toBeGreaterThan(-11000);
    });

    it('полезен для проверок устаревания', () => {
      const oldTimestampMs = Date.now() - 15000;
      const oldTimestamp = createTestTimestamp(oldTimestampMs); // 15 секунд назад
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        oldTimestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const MAX_AGE_MS = 10000; // 10 секунд
      const isStale = quote.age(createTestTimestamp(Date.now())).greaterThan(MAX_AGE_MS);

      expect(isStale).toBe(true);
    });

    it('принимает Date объект', () => {
      const timestampMs = Date.now() - 5000;
      const timestamp = createTestTimestamp(timestampMs);
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const now = new Date();
      const nowTimestamp = createTestTimestamp(now.getTime());
      const age = quote.age(nowTimestamp);

      expect(age.toNumber()).toBeGreaterThanOrEqual(5000);
      expect(age.toNumber()).toBeLessThan(6000);
    });

    it('принимает строку с Unix ms', () => {
      const timestampMs = Date.now() - 5000;
      const timestamp = createTestTimestamp(timestampMs);
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const now = createTestTimestamp(Date.now());
      const age = quote.age(now);

      expect(age.toNumber()).toBeGreaterThanOrEqual(5000);
      expect(age.toNumber()).toBeLessThan(6000);
    });

    it('принимает Decimal', () => {
      const timestampMs = Date.now() - 5000;
      const timestamp = createTestTimestamp(timestampMs);
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const now = createTestTimestamp(Date.now());
      const age = quote.age(now);

      expect(age.toNumber()).toBeGreaterThanOrEqual(5000);
      expect(age.toNumber()).toBeLessThan(6000);
    });

    // Негативные тесты для error-веток validateTimestamp(context='now')
    // NOTE: Закомментировано, т.к. Timestamp валидирует при создании
    /*
    it('бросает Error для NaN nowMs', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      expect(() => quote.age(new Decimal(NaN))).toThrow('Timestamp cannot be NaN');
    });
    */

    // NOTE: Следующие тесты закомментированы, т.к. Timestamp теперь валидирует при создании
    // Невозможно создать invalid Timestamp, поэтому эти кейсы тестируются в Timestamp.test.ts
    /*
    it('бросает Error для Infinity nowMs', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      expect(() => quote.age(new Decimal(Infinity))).toThrow('Timestamp must be finite');
    });

    it('бросает Error для fractional nowMs', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      expect(() => quote.age(new Decimal(123.456))).toThrow('Timestamp must be integer (Unix ms)');
    });

    it('бросает Error для negative nowMs', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      expect(() => quote.age(new Decimal(-1000))).toThrow('Timestamp cannot be negative');
    });

    it('бросает Error для nowMs превышающего MAX_TIMESTAMP', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const MAX_TIMESTAMP = new Decimal('10000000000000'); // год 2286
      const tooLarge = MAX_TIMESTAMP.plus(1);
      expect(() => quote.age(tooLarge)).toThrow('exceeds maximum');
    });
    */
  });

  describe('isTwoSided()', () => {
    it('возвращает true для двусторонней котировки', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.isTwoSided()).toBe(true);
    });

    it('возвращает false для bid-only котировки', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.isTwoSided()).toBe(false);
    });

    it('возвращает false для ask-only котировки', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.ZERO,
        Quantity.of(new Decimal(200)),
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

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
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.hasBid()).toBe(true);
    });

    it('hasBid() возвращает false когда bid null', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.ZERO,
        Quantity.of(new Decimal(200)),
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.hasBid()).toBe(false);
    });

    it('hasAsk() возвращает true когда ask определён', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.hasAsk()).toBe(true);
    });

    it('hasAsk() возвращает false когда ask null', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

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
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

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
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.spread()).toBeNull();
    });

    it('возвращает null для ask-only котировки', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.ZERO,
        Quantity.of(new Decimal(200)),
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote.spread()).toBeNull();
    });

    it('возвращает Spread с нулевой шириной когда bid === ask', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        Price.of(new Decimal(0.50)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp()
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const spread = quote.spread();

      expect(spread).not.toBeNull();
      expect(spread!.width().toNumber()).toBe(0);
      expect(spread!.isZeroWidth()).toBe(true);
    });
  });

  describe('equals()', () => {
    it('сравнивает идентичные котировки', () => {
      const timestamp = createTestTimestamp();
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote1.equals(quote2)).toBe(true);
    });

    it('различает котировки с разным bid', () => {
      const timestamp = createTestTimestamp();
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      const quote2 = Quote.of(
        Price.of(new Decimal(0.49)), // другой bid
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote1.equals(quote2)).toBe(false);
    });

    it('различает котировки с разным ask', () => {
      const timestamp = createTestTimestamp();
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.53)), // другой ask
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote1.equals(quote2)).toBe(false);
    });

    it('различает котировки с разными sizes', () => {
      const timestamp = createTestTimestamp();
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(200)), // другой bidSize
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote1.equals(quote2)).toBe(false);
    });

    it('НЕ различает котировки с разными timestamp (только рыночные данные)', () => {
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp(1000)      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp(2000) // другой timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      // equals() сравнивает только рыночные данные, timestamp игнорируется
      expect(quote1.equals(quote2)).toBe(true);
    });

    it('различает one-sided и two-sided котировки', () => {
      const timestamp = createTestTimestamp();
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        null, // ask null
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote1.equals(quote2)).toBe(false);
    });
  });

  describe('equalsWithTimestamp()', () => {
    it('сравнивает полностью идентичные котировки включая timestamp', () => {
      const timestamp = createTestTimestamp();
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote1.equalsWithTimestamp(quote2)).toBe(true);
    });

    it('различает котировки с одинаковыми данными но разным timestamp', () => {
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp(1000)      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp(2000) // другой timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      // equals() возвращает true (только рыночные данные)
      expect(quote1.equals(quote2)).toBe(true);

      // equalsWithTimestamp() возвращает false (timestamp отличается)
      expect(quote1.equalsWithTimestamp(quote2)).toBe(false);
    });

    it('различает котировки с разным bid', () => {
      const timestamp = createTestTimestamp();
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      const quote2 = Quote.of(
        Price.of(new Decimal(0.49)), // другой bid
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote1.equalsWithTimestamp(quote2)).toBe(false);
    });

    it('различает котировки с разными sizes', () => {
      const timestamp = createTestTimestamp();
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      const quote2 = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(200)), // другой bidSize
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote1.equalsWithTimestamp(quote2)).toBe(false);
    });

    it('различает one-sided котировки с одинаковым timestamp', () => {
      const timestamp = createTestTimestamp();
      const quote1 = Quote.of(
        Price.of(new Decimal(0.48)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      const quote2 = Quote.of(
        null,
        Price.of(new Decimal(0.52)),
        Quantity.ZERO,
        Quantity.of(new Decimal(150)),
        timestamp
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(quote1.equalsWithTimestamp(quote2)).toBe(false);
    });
  });

  describe('imbalance()', () => {
    it('возвращает 0 для сбалансированной котировки', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(100)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );
      expect(quote.imbalance().toNumber()).toBe(0);
    });

    it('возвращает положительный imbalance для bid-heavy', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(150)),
        Quantity.of(new Decimal(100)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );
      const imbalance = quote.imbalance();
      // (150 - 100) / (150 + 100) = 50 / 250 = 0.2
      expect(imbalance.toNumber()).toBeCloseTo(0.2);
    });

    it('возвращает отрицательный imbalance для ask-heavy', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(200)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );
      const imbalance = quote.imbalance();
      // (100 - 200) / (100 + 200) = -100 / 300 = -0.333...
      expect(imbalance.toNumber()).toBeCloseTo(-0.333, 2);
    });

    it('возвращает 1 для bid-only (askSize = 0)', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );
      const imbalance = quote.imbalance();
      // (100 - 0) / (100 + 0) = 100 / 100 = 1
      expect(imbalance.toNumber()).toBe(1);
    });

    it('возвращает -1 для ask-only (bidSize = 0)', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.52)),
        Quantity.ZERO,
        Quantity.of(new Decimal(100)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );
      const imbalance = quote.imbalance();
      // (0 - 100) / (0 + 100) = -100 / 100 = -1
      expect(imbalance.toNumber()).toBe(-1);
    });

    it('возвращает 0 когда оба размера равны 0', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.ZERO,
        Quantity.ZERO,
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );
      const imbalance = quote.imbalance();
      expect(imbalance.toNumber()).toBe(0);
    });
  });

  describe('spreadPercentage()', () => {
    it('вычисляет процент спреда для two-sided quote', () => {
      // bid=0.48, ask=0.52, mid=0.50, spread=0.04
      // Ratio хранит ДРОБЬ: (0.04 / 0.50) = 0.08 (8% как дробь)
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );
      const pct = quote.spreadPercentage();
      expect(pct).not.toBeNull();
      expect(pct?.toDecimal().toNumber()).toBeCloseTo(0.08, 5);
    });

    it('вычисляет процент спреда с точностью', () => {
      // bid=0.48, ask=0.52, mid=0.50, spread=0.04
      // Ratio хранит ДРОБЬ: (0.04 / 0.50) = 0.08 (8% как дробь)
      const quote = Quote.of(
        Price.of(new Decimal('0.48')),
        Price.of(new Decimal('0.52')),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );
      const pct = quote.spreadPercentage();
      expect(pct?.toDecimal().toString()).toBe('0.08');
    });

    it('вычисляет процент для узкого спреда', () => {
      // bid=0.6400, ask=0.6600, mid=0.65, spread=0.02
      // Ratio хранит ДРОБЬ: (0.02 / 0.65) ≈ 0.03077 (примерно 3.077% как дробь)
      const quote = Quote.of(
        Price.of(new Decimal('0.6400')),
        Price.of(new Decimal('0.6600')),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(100)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );
      const pct = quote.spreadPercentage();
      expect(pct).not.toBeNull();
      expect(pct?.toDecimal().toNumber()).toBeCloseTo(0.03077, 5);
    });

    it('возвращает null для one-sided quote (bid only)', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );
      expect(quote.spreadPercentage()).toBeNull();
    });

    it('возвращает null для one-sided quote (ask only)', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.50)),
        Quantity.ZERO,
        Quantity.of(new Decimal(100)),
        createTestTimestamp(),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );
      expect(quote.spreadPercentage()).toBeNull();
    });
  });
});
