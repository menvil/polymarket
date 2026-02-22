import Decimal from 'decimal.js';
import type { MarketDataSourceId, InstrumentId } from '@polymarket/ids';
import { describe, it, expect } from '@jest/globals';
import { QuoteFormatter } from '../../../src/quote/adapters/QuoteFormatter.js';
import { Quote } from '../../../src/quote/core/index.js';
import { Price } from '../../../src/price/core/Price.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';

// Тестовые константы для sourceId и instrumentId
const TEST_SOURCE_ID = 'TEST_SOURCE' as MarketDataSourceId;
const TEST_INSTRUMENT_ID = 'TEST_INSTRUMENT' as InstrumentId;

/**
 * Создает тестовую котировку с заданными параметрами.
 *
 * @param bid - Цена бида (по умолчанию 0.48)
 * @param ask - Цена аска (по умолчанию 0.52)
 * @param bidSize - Размер бида (по умолчанию 100)
 * @param askSize - Размер аска (по умолчанию 150)
 * @param timestamp - Временная метка (по умолчанию Date.now())
 * @param sourceId - ID источника данных (по умолчанию TEST_SOURCE_ID)
 * @param instrumentId - ID инструмента (по умолчанию TEST_INSTRUMENT_ID)
 * @returns Объект котировки Quote
 *
 * @example
 * ```typescript
 * const quote = makeQuote(0.48, 0.52);
 * const bidOnlyQuote = makeQuote(0.50, null);
 * const customQuote = makeQuote(0.48, 0.52, 100, 150, Date.now(), 'BINANCE_WS' as MarketDataSourceId, 'BTC-USDT' as InstrumentId);
 * ```
 */
function makeQuote(
  bid: number | null = 0.48,
  ask: number | null = 0.52,
  bidSize: number = 100,
  askSize: number = 150,
  timestamp: number = Date.now(),
  sourceId: MarketDataSourceId = TEST_SOURCE_ID,
  instrumentId: InstrumentId = TEST_INSTRUMENT_ID
): Quote {
  return Quote.of(
    bid !== null ? Price.of(new Decimal(bid)) : null,
    ask !== null ? Price.of(new Decimal(ask)) : null,
    Quantity.of(new Decimal(bidSize)),
    Quantity.of(new Decimal(askSize)),
    new Decimal(timestamp),
    sourceId,
    instrumentId
  );
}

describe('QuoteFormatter', () => {
  describe('toDisplay()', () => {
    it('форматирует двустороннюю котировку', () => {
      const quote = makeQuote();

      const display = QuoteFormatter.toDisplay(quote);

      expect(display).toBe('0.4800 @ 100.00 / 0.5200 @ 150.00');
    });

    it('форматирует bid-only котировку', () => {
      const quote = makeQuote(0.50, null, 100, 0);

      const display = QuoteFormatter.toDisplay(quote);

      expect(display).toBe('0.5000 @ 100.00 / --');
    });

    it('форматирует ask-only котировку', () => {
      const quote = makeQuote(null, 0.51, 0, 200);

      const display = QuoteFormatter.toDisplay(quote);

      expect(display).toBe('-- / 0.5100 @ 200.00');
    });

    it('использует custom priceDecimals', () => {
      const quote = makeQuote();

      const display = QuoteFormatter.toDisplay(quote, { priceDecimals: 2 });

      expect(display).toBe('0.48 @ 100.00 / 0.52 @ 150.00');
    });

    it('использует custom sizeDecimals', () => {
      const quote = makeQuote(0.48, 0.52, 100.5, 150.75);

      const display = QuoteFormatter.toDisplay(quote, { sizeDecimals: 0 });

      // 100.5 rounds to 101, 150.75 rounds to 151
      expect(display).toBe('0.4800 @ 101 / 0.5200 @ 151');
    });

    it('включает timestamp когда includeTimestamp: true', () => {
      const timestamp = new Date('2024-01-15T12:30:00.000Z').getTime();
      const quote = makeQuote(0.48, 0.52, 100, 150, timestamp);

      const display = QuoteFormatter.toDisplay(quote, { includeTimestamp: true });

      expect(display).toContain('0.4800 @ 100.00 / 0.5200 @ 150.00');
      expect(display).toContain('[2024-01-15T12:30:00.000Z]');
    });
  });

  describe('toShort()', () => {
    it('форматирует двустороннюю котировку в краткий вид', () => {
      const quote = makeQuote();

      const short = QuoteFormatter.toShort(quote);

      expect(short).toBe('0.4800/0.5200');
    });

    it('форматирует bid-only котировку', () => {
      const quote = makeQuote(0.50, null, 100, 0);

      const short = QuoteFormatter.toShort(quote);

      expect(short).toBe('0.5000/--');
    });

    it('форматирует ask-only котировку', () => {
      const quote = makeQuote(null, 0.51, 0, 200);

      const short = QuoteFormatter.toShort(quote);

      expect(short).toBe('--/0.5100');
    });

    it('использует custom decimals', () => {
      const quote = makeQuote();

      const short = QuoteFormatter.toShort(quote, { priceDecimals: 2 });

      expect(short).toBe('0.48/0.52');
    });
  });

  describe('toDetailed()', () => {
    it('форматирует двустороннюю котировку с spread и mid', () => {
      const quote = makeQuote();

      const detailed = QuoteFormatter.toDetailed(quote);

      expect(detailed).toContain('Bid: 0.4800 @ 100.00');
      expect(detailed).toContain('Ask: 0.5200 @ 150.00');
      expect(detailed).toContain('Spread: 0.0400 (8.00%)');
      expect(detailed).toContain('Mid: 0.5000');
    });

    it('форматирует bid-only котировку без spread и mid', () => {
      const quote = makeQuote(0.50, null, 100, 0);

      const detailed = QuoteFormatter.toDetailed(quote);

      expect(detailed).toBe('Bid: 0.5000 @ 100.00');
      expect(detailed).not.toContain('Spread');
      expect(detailed).not.toContain('Mid');
    });

    it('форматирует ask-only котировку без spread и mid', () => {
      const quote = makeQuote(null, 0.51, 0, 200);

      const detailed = QuoteFormatter.toDetailed(quote);

      expect(detailed).toBe('Ask: 0.5100 @ 200.00');
      expect(detailed).not.toContain('Spread');
      expect(detailed).not.toContain('Mid');
    });

    it('скрывает spread когда includeSpread: false', () => {
      const quote = makeQuote();

      const detailed = QuoteFormatter.toDetailed(quote, { includeSpread: false });

      expect(detailed).toContain('Bid: 0.4800 @ 100.00');
      expect(detailed).toContain('Ask: 0.5200 @ 150.00');
      expect(detailed).not.toContain('Spread');
      expect(detailed).toContain('Mid: 0.5000');
    });

    it('скрывает mid когда includeMid: false', () => {
      const quote = makeQuote();

      const detailed = QuoteFormatter.toDetailed(quote, { includeMid: false });

      expect(detailed).toContain('Bid: 0.4800 @ 100.00');
      expect(detailed).toContain('Ask: 0.5200 @ 150.00');
      expect(detailed).toContain('Spread: 0.0400 (8.00%)');
      expect(detailed).not.toContain('Mid:');
    });

    it('включает timestamp когда includeTimestamp: true', () => {
      const timestamp = new Date('2024-01-15T12:30:00.000Z').getTime();
      const quote = makeQuote(0.48, 0.52, 100, 150, timestamp);

      const detailed = QuoteFormatter.toDetailed(quote, { includeTimestamp: true });

      expect(detailed).toContain('Time: 2024-01-15T12:30:00.000Z');
    });

    it('включает sourceId когда includeSource: true', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        'BINANCE_WS' as MarketDataSourceId,
        'BTC-USDT' as InstrumentId
      );

      const detailed = QuoteFormatter.toDetailed(quote, { includeSource: true });

      expect(detailed).toContain('Source: BINANCE_WS');
    });

    it('включает instrumentId когда includeInstrument: true', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        'BINANCE_WS' as MarketDataSourceId,
        'BTC-USDT' as InstrumentId
      );

      const detailed = QuoteFormatter.toDetailed(quote, { includeInstrument: true });

      expect(detailed).toContain('Instrument: BTC-USDT');
    });
  });

  describe('toTable()', () => {
    it('форматирует двустороннюю котировку в таблицу', () => {
      const quote = makeQuote();

      const table = QuoteFormatter.toTable(quote);

      expect(table).toContain('Side   Price    Size');
      expect(table).toContain('Bid    0.4800   100.00');
      expect(table).toContain('Ask    0.5200   150.00');
      expect(table).toContain('Spread 0.0400');
      expect(table).toContain('(8.00%)');
      expect(table).toContain('Mid    0.5000');
    });

    it('форматирует bid-only котировку в таблицу', () => {
      const quote = makeQuote(0.50, null, 100, 0);

      const table = QuoteFormatter.toTable(quote);

      expect(table).toContain('Bid    0.5000   100.00');
      expect(table).toContain('Ask    --       --');
      expect(table).not.toContain('Spread');
      expect(table).not.toContain('Mid');
    });

    it('форматирует ask-only котировку в таблицу', () => {
      const quote = makeQuote(null, 0.51, 0, 200);

      const table = QuoteFormatter.toTable(quote);

      expect(table).toContain('Bid    --       --');
      expect(table).toContain('Ask    0.5100   200.00');
      expect(table).not.toContain('Spread');
      expect(table).not.toContain('Mid');
    });

    it('включает timestamp когда includeTimestamp: true', () => {
      const timestamp = new Date('2024-01-15T12:30:00.000Z').getTime();
      const quote = makeQuote(0.48, 0.52, 100, 150, timestamp);

      const table = QuoteFormatter.toTable(quote, { includeTimestamp: true });

      expect(table).toContain('Time:  2024-01-15T12:30:00.000Z');
    });

    it('включает sourceId когда includeSource: true', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        'BINANCE_WS' as MarketDataSourceId,
        'BTC-USDT' as InstrumentId
      );

      const table = QuoteFormatter.toTable(quote, { includeSource: true });

      expect(table).toContain('Source: BINANCE_WS');
    });

    it('включает instrumentId когда includeInstrument: true', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        'BINANCE_WS' as MarketDataSourceId,
        'BTC-USDT' as InstrumentId
      );

      const table = QuoteFormatter.toTable(quote, { includeInstrument: true });

      expect(table).toContain('Instrument: BTC-USDT');
    });

    it('включает все метаданные когда все флаги true', () => {
      const timestamp = new Date('2024-01-15T12:30:00.000Z').getTime();
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(timestamp),
        'BINANCE_WS' as MarketDataSourceId,
        'BTC-USDT' as InstrumentId
      );

      const table = QuoteFormatter.toTable(quote, {
        includeTimestamp: true,
        includeSource: true,
        includeInstrument: true
      });

      expect(table).toContain('Time:  2024-01-15T12:30:00.000Z');
      expect(table).toContain('Source: BINANCE_WS');
      expect(table).toContain('Instrument: BTC-USDT');
    });
  });

  describe('formatSpread()', () => {
    it('форматирует spread с процентами', () => {
      const quote = makeQuote();

      const spread = QuoteFormatter.formatSpread(quote);

      expect(spread).toBe('0.0400 (8.00%)');
    });

    it('форматирует spread без процентов', () => {
      const quote = makeQuote();

      const spread = QuoteFormatter.formatSpread(quote, false);

      expect(spread).toBe('0.0400');
    });

    it('возвращает null для bid-only котировки', () => {
      const quote = makeQuote(0.50, null, 100, 0);

      const spread = QuoteFormatter.formatSpread(quote);

      expect(spread).toBeNull();
    });

    it('возвращает null для ask-only котировки', () => {
      const quote = makeQuote(null, 0.51, 0, 200);

      const spread = QuoteFormatter.formatSpread(quote);

      expect(spread).toBeNull();
    });
  });

  describe('formatMid()', () => {
    it('форматирует mid price', () => {
      const quote = makeQuote();

      const mid = QuoteFormatter.formatMid(quote);

      expect(mid).toBe('0.5000');
    });

    it('использует custom decimals', () => {
      const quote = makeQuote();

      const mid = QuoteFormatter.formatMid(quote, 2);

      expect(mid).toBe('0.50');
    });

    it('возвращает null для bid-only котировки', () => {
      const quote = makeQuote(0.50, null, 100, 0);

      const mid = QuoteFormatter.formatMid(quote);

      expect(mid).toBeNull();
    });

    it('возвращает null для ask-only котировки', () => {
      const quote = makeQuote(null, 0.51, 0, 200);

      const mid = QuoteFormatter.formatMid(quote);

      expect(mid).toBeNull();
    });
  });

  describe('formatCompact()', () => {
    it('форматирует двустороннюю котировку в компактный вид', () => {
      const quote = makeQuote();

      const compact = QuoteFormatter.formatCompact(quote);

      expect(compact).toBe('0.48/0.52 @100×150');
    });

    it('форматирует bid-only котировку', () => {
      const quote = makeQuote(0.50, null, 100, 0);

      const compact = QuoteFormatter.formatCompact(quote);

      expect(compact).toBe('0.50/-- @100×0');
    });

    it('форматирует ask-only котировку', () => {
      const quote = makeQuote(null, 0.52, 0, 150);

      const compact = QuoteFormatter.formatCompact(quote);

      expect(compact).toBe('--/0.52 @0×150');
    });

    it('использует custom priceDecimals', () => {
      const quote = makeQuote();

      const compact = QuoteFormatter.formatCompact(quote, 4);

      expect(compact).toBe('0.4800/0.5200 @100×150');
    });

    it('использует custom sizeDecimals', () => {
      const quote = makeQuote(0.48, 0.52, 100.5, 150.75);

      const compact = QuoteFormatter.formatCompact(quote, 2, 2);

      expect(compact).toBe('0.48/0.52 @100.50×150.75');
    });

    it('использует целые числа для размеров по умолчанию', () => {
      const quote = makeQuote(0.48, 0.52, 100.999, 150.111);

      const compact = QuoteFormatter.formatCompact(quote);

      // sizeDecimals=0 по умолчанию, округление до целых
      expect(compact).toBe('0.48/0.52 @101×150');
    });
  });

  describe('formatWithSpread()', () => {
    it('форматирует двустороннюю котировку с spread информацией', () => {
      const quote = makeQuote();

      const formatted = QuoteFormatter.formatWithSpread(quote);

      // spread = 0.04, в basis points = 400bp, mid = 0.50
      expect(formatted).toBe('0.48-0.52 (400bp, mid=0.50)');
    });

    it('форматирует bid-only котировку', () => {
      const quote = makeQuote(0.50, null, 100, 0);

      const formatted = QuoteFormatter.formatWithSpread(quote);

      expect(formatted).toBe('0.50 (bid only)');
    });

    it('форматирует ask-only котировку', () => {
      const quote = makeQuote(null, 0.52, 0, 150);

      const formatted = QuoteFormatter.formatWithSpread(quote);

      expect(formatted).toBe('0.52 (ask only)');
    });

    it('использует custom priceDecimals', () => {
      const quote = makeQuote();

      const formatted = QuoteFormatter.formatWithSpread(quote, 4);

      expect(formatted).toBe('0.4800-0.5200 (400bp, mid=0.5000)');
    });

    it('правильно вычисляет basis points для узкого spread', () => {
      const quote = makeQuote(0.499, 0.501);

      const formatted = QuoteFormatter.formatWithSpread(quote, 3);

      // spread = 0.002, в basis points = 20bp, mid = 0.500
      expect(formatted).toBe('0.499-0.501 (20bp, mid=0.500)');
    });

    it('правильно вычисляет basis points для широкого spread', () => {
      const quote = makeQuote(0.40, 0.60);

      const formatted = QuoteFormatter.formatWithSpread(quote, 2);

      // spread = 0.20, в basis points = 2000bp, mid = 0.50
      expect(formatted).toBe('0.40-0.60 (2000bp, mid=0.50)');
    });

    it('округляет basis points до целого числа', () => {
      const quote = makeQuote(0.499925, 0.500075);

      const formatted = QuoteFormatter.formatWithSpread(quote, 6);

      // spread = 0.00015, в basis points = 1.5bp → округляется до 2bp, mid = 0.500000
      expect(formatted).toBe('0.499925-0.500075 (2bp, mid=0.500000)');
    });
  });
});
