import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { QuoteService } from '../facade/QuoteService.js';
import { Quote } from '../core/Quote.js';
import { Price } from '../../price/core/Price.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { Ratio } from '../../ratio/core/Ratio.js';
import { QuoteErrorReason } from '../errors/QuoteErrorReason.js';
import { KnownMarketDataSources, asInstrumentId } from '@polymarket/ids';

describe('QuoteService Ratio Operations', () => {
  // Helper: создать Quote из чисел
  const createQuote = (bidPrice: number, askPrice: number, bidSize = 100, askSize = 100): Quote => {
    return Quote.of(
      Price.of(new Decimal(bidPrice)),
      Price.of(new Decimal(askPrice)),
      Quantity.of(new Decimal(bidSize)),
      Quantity.of(new Decimal(askSize)),
      new Decimal(Date.now()),
      KnownMarketDataSources.POLYMARKET_WS,
      asInstrumentId('TEST_INSTRUMENT')!
    );
  };

  describe('getMidPrice()', () => {
    it('вычисляет midpoint для quote', () => {
      const quote = createQuote(0.48, 0.52);
      const result = QuoteService.getMidPrice(quote);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('0.5');
      }
    });

    it('работает с узким spread', () => {
      const quote = createQuote(0.499, 0.501);
      const result = QuoteService.getMidPrice(quote);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('0.5');
      }
    });

    it('никогда не бросает исключения', () => {
      const quote = createQuote(0.48, 0.52);
      expect(() => QuoteService.getMidPrice(quote)).not.toThrow();
    });
  });

  describe('getSpreadRatio()', () => {
    it('вычисляет spread ratio для quote', () => {
      const quote = createQuote(0.48, 0.52);
      const result = QuoteService.getSpreadRatio(quote);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.08');
      }
    });

    it('никогда не бросает исключения', () => {
      const quote = createQuote(0.48, 0.52);
      expect(() => QuoteService.getSpreadRatio(quote)).not.toThrow();
    });
  });

  describe('shiftByRatio()', () => {
    it('сдвигает quote вверх сохраняя sizes', () => {
      const quote = createQuote(0.48, 0.52, 100, 200);
      const shiftRatio = Ratio.of(new Decimal(0.05)); // 5%

      const result = QuoteService.shiftByRatio(quote, shiftRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.spread()!.bid()!.value().toString()).toBe('0.505');
        expect(result.value.spread()!.ask()!.value().toString()).toBe('0.545');
        expect(result.value.bidSize().toNumber()).toBe(100); // sizes не изменились
        expect(result.value.askSize().toNumber()).toBe(200);
      }
    });

    it('сохраняет metadata (marketDataSourceId, instrumentId, timestamp)', () => {
      const quote = createQuote(0.48, 0.52);
      const shiftRatio = Ratio.of(new Decimal(0.02));

      const result = QuoteService.shiftByRatio(quote, shiftRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sourceId()).toBe(quote.sourceId());
        expect(result.value.instrumentId()).toBe(quote.instrumentId());
        expect(result.value.timestampMs()).toBe(quote.timestampMs());
      }
    });

    it('никогда не бросает исключения', () => {
      const quote = createQuote(0.48, 0.52);
      const ratio = Ratio.of(new Decimal(0.05));
      expect(() => QuoteService.shiftByRatio(quote, ratio)).not.toThrow();
    });
  });

  describe('widenByRatio()', () => {
    it('расширяет spread сохраняя sizes', () => {
      const quote = createQuote(0.48, 0.52, 50, 75);
      const deltaRatio = Ratio.of(new Decimal(0.02)); // 2% от mid

      const result = QuoteService.widenByRatio(quote, deltaRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.spread()!.bid()!.value().toString()).toBe('0.475');
        expect(result.value.spread()!.ask()!.value().toString()).toBe('0.525');
        expect(result.value.bidSize().toNumber()).toBe(50);
        expect(result.value.askSize().toNumber()).toBe(75);
      }
    });

    it('никогда не бросает исключения', () => {
      const quote = createQuote(0.48, 0.52);
      const ratio = Ratio.of(new Decimal(0.02));
      expect(() => QuoteService.widenByRatio(quote, ratio)).not.toThrow();
    });
  });

  describe('tightenByRatio()', () => {
    it('сужает spread сохраняя sizes', () => {
      const quote = createQuote(0.48, 0.52, 150, 250);
      const deltaRatio = Ratio.of(new Decimal(0.02)); // 2% от mid

      const result = QuoteService.tightenByRatio(quote, deltaRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.spread()!.bid()!.value().toString()).toBe('0.485');
        expect(result.value.spread()!.ask()!.value().toString()).toBe('0.515');
        expect(result.value.bidSize().toNumber()).toBe(150);
        expect(result.value.askSize().toNumber()).toBe(250);
      }
    });

    it('никогда не бросает исключения', () => {
      const quote = createQuote(0.48, 0.52);
      const ratio = Ratio.of(new Decimal(0.01));
      expect(() => QuoteService.tightenByRatio(quote, ratio)).not.toThrow();
    });
  });

  describe('skewByRatio()', () => {
    it('наклоняет spread сохраняя sizes', () => {
      const quote = createQuote(0.48, 0.52, 80, 120);
      const bidRatio = Ratio.of(new Decimal(0.02)); // +2%
      const askRatio = Ratio.of(new Decimal(-0.01)); // -1%

      const result = QuoteService.skewByRatio(quote, bidRatio, askRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.spread()!.bid()!.value().toString()).toBe('0.49');
        expect(result.value.spread()!.ask()!.value().toString()).toBe('0.515');
        expect(result.value.bidSize().toNumber()).toBe(80);
        expect(result.value.askSize().toNumber()).toBe(120);
      }
    });

    it('никогда не бросает исключения', () => {
      const quote = createQuote(0.48, 0.52);
      const bidRatio = Ratio.of(new Decimal(0.02));
      const askRatio = Ratio.of(new Decimal(-0.01));
      expect(() => QuoteService.skewByRatio(quote, bidRatio, askRatio)).not.toThrow();
    });
  });

  describe('scaleSizesByRatio()', () => {
    it('масштабирует sizes на 50% сохраняя prices', () => {
      const quote = createQuote(0.48, 0.52, 100, 200);
      const sizeFactor = Ratio.of(new Decimal(0.5)); // 50%

      const result = QuoteService.scaleSizesByRatio(quote, sizeFactor);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bidSize().toNumber()).toBe(50);
        expect(result.value.askSize().toNumber()).toBe(100);
        expect(result.value.spread()!.bid()!.value().toString()).toBe('0.48'); // prices не изменились
        expect(result.value.spread()!.ask()!.value().toString()).toBe('0.52');
      }
    });

    it('масштабирует sizes на 200% (удвоение)', () => {
      const quote = createQuote(0.48, 0.52, 100, 200);
      const sizeFactor = Ratio.of(new Decimal(2)); // 200%

      const result = QuoteService.scaleSizesByRatio(quote, sizeFactor);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bidSize().toNumber()).toBe(200);
        expect(result.value.askSize().toNumber()).toBe(400);
      }
    });

    it('работает с factor = 1 (нет изменений)', () => {
      const quote = createQuote(0.48, 0.52, 100, 200);
      const sizeFactor = Ratio.of(new Decimal(1));

      const result = QuoteService.scaleSizesByRatio(quote, sizeFactor);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bidSize().toNumber()).toBe(100);
        expect(result.value.askSize().toNumber()).toBe(200);
      }
    });

    it('фэйлится при factor <= 0', () => {
      const quote = createQuote(0.48, 0.52, 100, 200);
      const sizeFactor = Ratio.of(new Decimal(0));

      const result = QuoteService.scaleSizesByRatio(quote, sizeFactor);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_SIZE_FACTOR);
        expect(result.error.message).toContain('positive');
      }
    });

    it('фэйлится при отрицательном factor', () => {
      const quote = createQuote(0.48, 0.52, 100, 200);
      const sizeFactor = Ratio.of(new Decimal(-0.5));

      const result = QuoteService.scaleSizesByRatio(quote, sizeFactor);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_SIZE_FACTOR);
      }
    });

    it('сохраняет prices и metadata', () => {
      const quote = createQuote(0.48, 0.52, 100, 200);
      const sizeFactor = Ratio.of(new Decimal(0.5));

      const result = QuoteService.scaleSizesByRatio(quote, sizeFactor);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Prices не изменились
        expect(result.value.spread()!.bid()!.value().toString()).toBe('0.48');
        expect(result.value.spread()!.ask()!.value().toString()).toBe('0.52');

        // Metadata сохранена
        expect(result.value.sourceId()).toBe(quote.sourceId());
        expect(result.value.instrumentId()).toBe(quote.instrumentId());
        expect(result.value.timestampMs()).toBe(quote.timestampMs());
      }
    });

    it('никогда не бросает исключения', () => {
      const quote = createQuote(0.48, 0.52, 100, 200);
      const sizeFactor = Ratio.of(new Decimal(0.5));
      expect(() => QuoteService.scaleSizesByRatio(quote, sizeFactor)).not.toThrow();
    });
  });

  describe('Integration scenarios', () => {
    it('market making workflow: adjust spread и scale sizes', () => {
      const quote = createQuote(0.48, 0.52, 100, 100);

      // 1. При volatility расширяем spread на 5%
      const widenedResult = QuoteService.widenByRatio(quote, Ratio.of(new Decimal(0.05)));
      expect(widenedResult.ok).toBe(true);
      if (!widenedResult.ok) return;

      // 2. При риске уменьшаем sizes на 50%
      const scaledResult = QuoteService.scaleSizesByRatio(widenedResult.value, Ratio.of(new Decimal(0.5)));
      expect(scaledResult.ok).toBe(true);
      if (!scaledResult.ok) return;

      // Проверяем результат
      const final = scaledResult.value;
      expect(final.spread()!.width().greaterThan(quote.spread()!.width())).toBe(true); // spread шире
      expect(final.bidSize().toNumber()).toBe(50); // sizes меньше
      expect(final.askSize().toNumber()).toBe(50);
    });

    it('inventory adjustment workflow: skew spread + adjust sizes asymmetrically', () => {
      const quote = createQuote(0.48, 0.52, 100, 100);

      // При избытке long позиции: поднимаем bid, опускаем ask
      const skewedResult = QuoteService.skewByRatio(
        quote,
        Ratio.of(new Decimal(0.02)), // bid +2%
        Ratio.of(new Decimal(-0.01))  // ask -1%
      );

      expect(skewedResult.ok).toBe(true);
      if (skewedResult.ok) {
        expect(skewedResult.value.spread()!.bid()!.value().greaterThan(quote.spread()!.bid()!.value())).toBe(true);
        expect(skewedResult.value.spread()!.ask()!.value().lessThan(quote.spread()!.ask()!.value())).toBe(true);
      }
    });

    it('competitive pricing workflow: tighten spread для лучшей цены', () => {
      const quote = createQuote(0.48, 0.52, 100, 100);

      // Сужаем spread на 1% чтобы быть конкурентоспособными
      const tightenedResult = QuoteService.tightenByRatio(quote, Ratio.of(new Decimal(0.01)));

      expect(tightenedResult.ok).toBe(true);
      if (tightenedResult.ok) {
        const newWidth = tightenedResult.value.spread()!.width();
        const oldWidth = quote.spread()!.width();
        expect(newWidth.lessThan(oldWidth)).toBe(true);
      }
    });
  });
});
