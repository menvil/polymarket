import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { QuoteFormatter } from '../../../src/quote/adapters/QuoteFormatter.js';
import { Quote } from '../../../src/quote/core/index.js';
import { Price } from '../../../src/price/core/Price.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';

describe('QuoteFormatter', () => {
  describe('toDisplay()', () => {
    it('форматирует двустороннюю котировку', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const display = QuoteFormatter.toDisplay(quote);

      expect(display).toBe('0.4800 @ 100.00 / 0.5200 @ 150.00');
    });

    it('форматирует bid-only котировку', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(0)),
        new Decimal(Date.now())
      );

      const display = QuoteFormatter.toDisplay(quote);

      expect(display).toBe('0.5000 @ 100.00 / --');
    });

    it('форматирует ask-only котировку', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.of(new Decimal(0)),
        Quantity.of(new Decimal(200)),
        new Decimal(Date.now())
      );

      const display = QuoteFormatter.toDisplay(quote);

      expect(display).toBe('-- / 0.5100 @ 200.00');
    });

    it('использует custom priceDecimals', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const display = QuoteFormatter.toDisplay(quote, { priceDecimals: 2 });

      expect(display).toBe('0.48 @ 100.00 / 0.52 @ 150.00');
    });

    it('использует custom sizeDecimals', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100.5)),
        Quantity.of(new Decimal(150.75)),
        new Decimal(Date.now())
      );

      const display = QuoteFormatter.toDisplay(quote, { sizeDecimals: 0 });

      // 100.5 rounds to 101, 150.75 rounds to 151
      expect(display).toBe('0.4800 @ 101 / 0.5200 @ 151');
    });

    it('включает timestamp когда includeTimestamp: true', () => {
      const timestamp = new Date('2024-01-15T12:30:00.000Z').getTime();
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(timestamp)
      );

      const display = QuoteFormatter.toDisplay(quote, { includeTimestamp: true });

      expect(display).toContain('0.4800 @ 100.00 / 0.5200 @ 150.00');
      expect(display).toContain('[2024-01-15T12:30:00.000Z]');
    });
  });

  describe('toShort()', () => {
    it('форматирует двустороннюю котировку в краткий вид', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const short = QuoteFormatter.toShort(quote);

      expect(short).toBe('0.4800/0.5200');
    });

    it('форматирует bid-only котировку', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(0)),
        new Decimal(Date.now())
      );

      const short = QuoteFormatter.toShort(quote);

      expect(short).toBe('0.5000/--');
    });

    it('форматирует ask-only котировку', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.of(new Decimal(0)),
        Quantity.of(new Decimal(200)),
        new Decimal(Date.now())
      );

      const short = QuoteFormatter.toShort(quote);

      expect(short).toBe('--/0.5100');
    });

    it('использует custom decimals', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const short = QuoteFormatter.toShort(quote, 2);

      expect(short).toBe('0.48/0.52');
    });
  });

  describe('toDetailed()', () => {
    it('форматирует двустороннюю котировку с spread и mid', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const detailed = QuoteFormatter.toDetailed(quote);

      expect(detailed).toContain('Bid: 0.4800 @ 100.00');
      expect(detailed).toContain('Ask: 0.5200 @ 150.00');
      expect(detailed).toContain('Spread: 0.0400 (8.00%)');
      expect(detailed).toContain('Mid: 0.5000');
    });

    it('форматирует bid-only котировку без spread и mid', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(0)),
        new Decimal(Date.now())
      );

      const detailed = QuoteFormatter.toDetailed(quote);

      expect(detailed).toBe('Bid: 0.5000 @ 100.00');
      expect(detailed).not.toContain('Spread');
      expect(detailed).not.toContain('Mid');
    });

    it('форматирует ask-only котировку без spread и mid', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.of(new Decimal(0)),
        Quantity.of(new Decimal(200)),
        new Decimal(Date.now())
      );

      const detailed = QuoteFormatter.toDetailed(quote);

      expect(detailed).toBe('Ask: 0.5100 @ 200.00');
      expect(detailed).not.toContain('Spread');
      expect(detailed).not.toContain('Mid');
    });

    it('скрывает spread когда includeSpread: false', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const detailed = QuoteFormatter.toDetailed(quote, { includeSpread: false });

      expect(detailed).toContain('Bid: 0.4800 @ 100.00');
      expect(detailed).toContain('Ask: 0.5200 @ 150.00');
      expect(detailed).not.toContain('Spread');
      expect(detailed).toContain('Mid: 0.5000');
    });

    it('скрывает mid когда includeMid: false', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const detailed = QuoteFormatter.toDetailed(quote, { includeMid: false });

      expect(detailed).toContain('Bid: 0.4800 @ 100.00');
      expect(detailed).toContain('Ask: 0.5200 @ 150.00');
      expect(detailed).toContain('Spread: 0.0400 (8.00%)');
      expect(detailed).not.toContain('Mid:');
    });

    it('включает timestamp когда includeTimestamp: true', () => {
      const timestamp = new Date('2024-01-15T12:30:00.000Z').getTime();
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(timestamp)
      );

      const detailed = QuoteFormatter.toDetailed(quote, { includeTimestamp: true });

      expect(detailed).toContain('Time: 2024-01-15T12:30:00.000Z');
    });
  });

  describe('toTable()', () => {
    it('форматирует двустороннюю котировку в таблицу', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const table = QuoteFormatter.toTable(quote);

      expect(table).toContain('Side   Price    Size');
      expect(table).toContain('Bid    0.4800   100.00');
      expect(table).toContain('Ask    0.5200   150.00');
      expect(table).toContain('Spread 0.0400');
      expect(table).toContain('(8.00%)');
      expect(table).toContain('Mid    0.5000');
    });

    it('форматирует bid-only котировку в таблицу', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(0)),
        new Decimal(Date.now())
      );

      const table = QuoteFormatter.toTable(quote);

      expect(table).toContain('Bid    0.5000   100.00');
      expect(table).toContain('Ask    --       --');
      expect(table).not.toContain('Spread');
      expect(table).not.toContain('Mid');
    });

    it('форматирует ask-only котировку в таблицу', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.of(new Decimal(0)),
        Quantity.of(new Decimal(200)),
        new Decimal(Date.now())
      );

      const table = QuoteFormatter.toTable(quote);

      expect(table).toContain('Bid    --       --');
      expect(table).toContain('Ask    0.5100   200.00');
      expect(table).not.toContain('Spread');
      expect(table).not.toContain('Mid');
    });

    it('включает timestamp когда includeTimestamp: true', () => {
      const timestamp = new Date('2024-01-15T12:30:00.000Z').getTime();
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(timestamp)
      );

      const table = QuoteFormatter.toTable(quote, { includeTimestamp: true });

      expect(table).toContain('Time:  2024-01-15T12:30:00.000Z');
    });
  });

  describe('formatSpread()', () => {
    it('форматирует spread с процентами', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const spread = QuoteFormatter.formatSpread(quote);

      expect(spread).toBe('0.0400 (8.00%)');
    });

    it('форматирует spread без процентов', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const spread = QuoteFormatter.formatSpread(quote, false);

      expect(spread).toBe('0.0400');
    });

    it('возвращает null для bid-only котировки', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(0)),
        new Decimal(Date.now())
      );

      const spread = QuoteFormatter.formatSpread(quote);

      expect(spread).toBeNull();
    });

    it('возвращает null для ask-only котировки', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.of(new Decimal(0)),
        Quantity.of(new Decimal(200)),
        new Decimal(Date.now())
      );

      const spread = QuoteFormatter.formatSpread(quote);

      expect(spread).toBeNull();
    });
  });

  describe('formatMid()', () => {
    it('форматирует mid price', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const mid = QuoteFormatter.formatMid(quote);

      expect(mid).toBe('0.5000');
    });

    it('использует custom decimals', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now())
      );

      const mid = QuoteFormatter.formatMid(quote, 2);

      expect(mid).toBe('0.50');
    });

    it('возвращает null для bid-only котировки', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(0)),
        new Decimal(Date.now())
      );

      const mid = QuoteFormatter.formatMid(quote);

      expect(mid).toBeNull();
    });

    it('возвращает null для ask-only котировки', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.of(new Decimal(0)),
        Quantity.of(new Decimal(200)),
        new Decimal(Date.now())
      );

      const mid = QuoteFormatter.formatMid(quote);

      expect(mid).toBeNull();
    });
  });
});
