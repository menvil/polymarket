import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { QuoteService } from '../../../../src/quote/facade/QuoteService.js';
import { Quote } from '../../../../src/quote/core/Quote.js';
import { Price } from '../../../../src/price/core/Price.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';
import { Ratio } from '../../../../src/ratio/core/Ratio.js';
import { QuoteErrorReason } from '../../../../src/quote/errors/QuoteErrorReason.js';
import { InvalidQuoteError } from '@polymarket/errors';
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

  describe('One-sided quote негативные сценарии (Never Throw контракт)', () => {
    // Helper: создать bid-only quote
    const createBidOnly = (bidPrice: number, bidSize = 100): Quote => {
      const result = QuoteService.bidOnly(
        new Decimal(bidPrice),
        new Decimal(bidSize),
        KnownMarketDataSources.POLYMARKET_WS,
        asInstrumentId('TEST_INSTRUMENT')!,
        Date.now()
      );
      if (!result.ok) throw new Error('Failed to create bid-only quote');
      return result.value;
    };

    it('getMidPrice возвращает Err для bid-only quote (без TypeErrror)', () => {
      const bidOnly = createBidOnly(0.50, 100);
      const result = QuoteService.getMidPrice(bidOnly);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });

    it('getSpreadRatio возвращает Err для bid-only quote (без TypeError)', () => {
      const bidOnly = createBidOnly(0.50, 100);
      const result = QuoteService.getSpreadRatio(bidOnly);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MID_UNAVAILABLE);
      }
    });

    it('shiftByRatio возвращает Err для bid-only quote (без TypeError)', () => {
      const bidOnly = createBidOnly(0.50, 100);
      const ratio = Ratio.of(new Decimal(0.05));
      const result = QuoteService.shiftByRatio(bidOnly, ratio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });

    it('widenByRatio возвращает Err для bid-only quote (без TypeError)', () => {
      const bidOnly = createBidOnly(0.50, 100);
      const ratio = Ratio.of(new Decimal(0.05));
      const result = QuoteService.widenByRatio(bidOnly, ratio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });

    it('tightenByRatio возвращает Err для bid-only quote (без TypeError)', () => {
      const bidOnly = createBidOnly(0.50, 100);
      const ratio = Ratio.of(new Decimal(0.05));
      const result = QuoteService.tightenByRatio(bidOnly, ratio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });

    it('skewByRatio возвращает Err для bid-only quote (без TypeError)', () => {
      const bidOnly = createBidOnly(0.50, 100);
      const bidRatio = Ratio.of(new Decimal(0.95));
      const askRatio = Ratio.of(new Decimal(1.05));
      const result = QuoteService.skewByRatio(bidOnly, bidRatio, askRatio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });

    it('scaleSizesByRatio возвращает Err для bid-only quote с NOT_TWO_SIDED reason', () => {
      const bidOnly = createBidOnly(0.50, 100);
      const factor = Ratio.of(new Decimal(1.5));
      const result = QuoteService.scaleSizesByRatio(bidOnly, factor);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });
  });

  describe('Ask-only quote негативные сценарии (симметричные bid-only)', () => {
    // Helper: создать ask-only quote
    const createAskOnly = (askPrice: number, askSize = 100): Quote => {
      const result = QuoteService.askOnly(
        new Decimal(askPrice),
        new Decimal(askSize),
        KnownMarketDataSources.POLYMARKET_WS,
        asInstrumentId('TEST_INSTRUMENT')!,
        Date.now()
      );
      if (!result.ok) throw new Error('Failed to create ask-only quote');
      return result.value;
    };

    it('getMidPrice возвращает Err для ask-only quote (без TypeError)', () => {
      const askOnly = createAskOnly(0.55, 100);
      const result = QuoteService.getMidPrice(askOnly);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });

    it('getSpreadRatio возвращает Err для ask-only quote (без TypeError)', () => {
      const askOnly = createAskOnly(0.55, 100);
      const result = QuoteService.getSpreadRatio(askOnly);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MID_UNAVAILABLE);
      }
    });

    it('shiftByRatio возвращает Err для ask-only quote (без TypeError)', () => {
      const askOnly = createAskOnly(0.55, 100);
      const shiftRatio = Ratio.of(new Decimal(0.02));
      const result = QuoteService.shiftByRatio(askOnly, shiftRatio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });

    it('widenByRatio возвращает Err для ask-only quote (без TypeError)', () => {
      const askOnly = createAskOnly(0.55, 100);
      const ratio = Ratio.of(new Decimal(0.05));
      const result = QuoteService.widenByRatio(askOnly, ratio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });

    it('tightenByRatio возвращает Err для ask-only quote (без TypeError)', () => {
      const askOnly = createAskOnly(0.55, 100);
      const ratio = Ratio.of(new Decimal(0.05));
      const result = QuoteService.tightenByRatio(askOnly, ratio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });

    it('skewByRatio возвращает Err для ask-only quote (без TypeError)', () => {
      const askOnly = createAskOnly(0.55, 100);
      const bidRatio = Ratio.of(new Decimal(0.95));
      const askRatio = Ratio.of(new Decimal(1.05));
      const result = QuoteService.skewByRatio(askOnly, bidRatio, askRatio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });

    it('scaleSizesByRatio возвращает Err для ask-only quote с NOT_TWO_SIDED reason', () => {
      const askOnly = createAskOnly(0.55, 100);
      const factor = Ratio.of(new Decimal(1.5));
      const result = QuoteService.scaleSizesByRatio(askOnly, factor);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.NOT_TWO_SIDED);
      }
    });
  });

  describe('Out-of-bounds сценарии (SpreadService errors)', () => {
    it('shiftByRatio возвращает Err когда результат выходит за MAX_PRICE', () => {
      // Создаём quote близко к верхней границе
      const quote = createQuote(0.98, 0.99, 100, 100);
      // Сдвигаем вверх на 10% от mid (mid=0.985, 10%=0.0985), результат превысит 0.9999
      const shiftRatio = Ratio.of(new Decimal(0.10));

      const result = QuoteService.shiftByRatio(quote, shiftRatio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.RATIO_OUT_OF_BOUNDS);
      }
    });

    it('shiftByRatio возвращает Err когда результат выходит за MIN_PRICE', () => {
      // Создаём quote близко к нижней границе
      const quote = createQuote(0.001, 0.002, 100, 100);
      // Сдвигаем вниз на 90% (результат будет ниже MIN_PRICE)
      const shiftRatio = Ratio.of(new Decimal(-0.90));

      const result = QuoteService.shiftByRatio(quote, shiftRatio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.RATIO_OUT_OF_BOUNDS);
      }
    });

    it('widenByRatio возвращает Err когда расширение выходит за границы', () => {
      // Создаём quote близко к верхней границе
      const quote = createQuote(0.98, 0.99, 100, 100);
      // Расширяем на 5% от mid, ask выйдет за MAX_PRICE
      const deltaRatio = Ratio.of(new Decimal(0.05));

      const result = QuoteService.widenByRatio(quote, deltaRatio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.RATIO_OUT_OF_BOUNDS);
      }
    });

    it('skewByRatio возвращает Err когда skew выходит за границы', () => {
      // Создаём quote близко к верхней границе
      const quote = createQuote(0.98, 0.99, 100, 100);
      // Поднимаем обе стороны, ask выйдет за MAX_PRICE
      const bidRatio = Ratio.of(new Decimal(0.05));
      const askRatio = Ratio.of(new Decimal(0.05));

      const result = QuoteService.skewByRatio(quote, bidRatio, askRatio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.RATIO_OUT_OF_BOUNDS);
      }
    });

    it('tightenByRatio возвращает Err при негативном ratio (SpreadService error)', () => {
      // Создаём валидную quote
      const quote = createQuote(0.48, 0.52, 100, 100);
      // Пытаемся сузить spread на негативный ratio (невалидная операция)
      const negativeRatio = Ratio.of(new Decimal(-0.1));

      const result = QuoteService.tightenByRatio(quote, negativeRatio);

      // Должно фэйлиться из-за ошибки SpreadService (line 1311 rewrap branch)
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // SpreadService вернёт ошибку, которая rewrap'ится в InvalidQuoteError
        expect(result.error).toBeInstanceOf(InvalidQuoteError);
        // Проверяем reason/контекст для фиксации маппинга причин
        expect(result.error.context?.reason).toBe(QuoteErrorReason.RATIO_OUT_OF_BOUNDS);
      }
    });
  });
});
