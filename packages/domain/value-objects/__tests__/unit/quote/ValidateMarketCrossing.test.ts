import Decimal from 'decimal.js';
import type { MarketDataSourceId, InstrumentId } from '@polymarket/ids';
import { describe, it, expect } from '@jest/globals';
import { ValidateMarketCrossing } from '../../../src/quote/rules/ValidateMarketCrossing.js';
import { Quote } from '../../../src/quote/core/Quote.js';
import { Price } from '../../../src/price/core/Price.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { QuoteErrorReason } from '../../../src/quote/errors/QuoteErrorReason.js';

// Тестовые константы для sourceId и instrumentId
const TEST_SOURCE_ID = 'TEST_SOURCE' as MarketDataSourceId;
const TEST_INSTRUMENT_ID = 'TEST_INSTRUMENT' as InstrumentId;

describe('ValidateMarketCrossing', () => {
  describe('checkQuote()', () => {
    it('returns Ok для нормальной котировки (не пересекает)', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)), // bid
        Price.of(new Decimal(0.52)), // ask
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.50));
      const orderbookAsk = Price.of(new Decimal(0.51));

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(true);
    });

    it('returns Err когда quoteBid >= orderbookAsk (пересекает)', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.51)), // наш bid
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.50));
      const orderbookAsk = Price.of(new Decimal(0.51)); // наш bid >= orderbook ask

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
        expect(result.error.context?.side).toBe('bid');
        expect(result.error.context?.quoteBid).toBe(0.51);
        expect(result.error.context?.orderbookAsk).toBe(0.51);
      }
    });

    it('returns Err когда ask <= orderbook bid (пересекает)', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.50)), // наш ask
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.50)); // наш ask <= orderbook bid
      const orderbookAsk = Price.of(new Decimal(0.51));

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
        expect(result.error.context?.side).toBe('ask');
        expect(result.error.context?.quoteAsk).toBe(0.50);
        expect(result.error.context?.orderbookBid).toBe(0.50);
      }
    });

    it('returns Ok когда наш bid null (bid-only check пропускается)', () => {
      const quote = Quote.of(
        null, // bid null
        Price.of(new Decimal(0.52)),
        Quantity.ZERO,
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.50));
      const orderbookAsk = Price.of(new Decimal(0.51));

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(true);
    });

    it('returns Ok когда orderbook ask null (bid-only check пропускается)', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.51)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.50));

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, null);

      expect(result.ok).toBe(true);
    });

    it('returns Ok когда наш ask null (ask-only check пропускается)', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        null, // ask null
        Quantity.of(new Decimal(100)),
        Quantity.ZERO,
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.50));
      const orderbookAsk = Price.of(new Decimal(0.51));

      const result = ValidateMarketCrossing.checkQuote(quote, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(true);
    });

    it('returns Ok когда orderbook bid null (ask-only check пропускается)', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.50)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookAsk = Price.of(new Decimal(0.51));

      const result = ValidateMarketCrossing.checkQuote(quote, null, orderbookAsk);

      expect(result.ok).toBe(true);
    });

    it('returns Err с side="bid" когда bid >= orderbookAsk, даже если ask не пересекает', () => {
      // Создаём ситуацию где bid пересекает orderbook ask
      const crossingQuote = Quote.of(
        Price.of(new Decimal(0.52)), // наш bid >= orderbook ask (0.51)
        Price.of(new Decimal(0.53)), // валидный ask > bid
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.50));
      const orderbookAsk = Price.of(new Decimal(0.51));

      const result = ValidateMarketCrossing.checkQuote(crossingQuote, orderbookBid, orderbookAsk);

      // Должна вернуться ошибка (bid пересекает)
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
        expect(result.error.context?.side).toBe('bid');
      }
    });

    it('returns Err с side="bid" когда обе стороны пересекают одновременно (quoteBid >= orderbookAsk AND quoteAsk <= orderbookBid)', () => {
      // Создаём ситуацию где ОБЕ стороны пересекают рынок
      // Orderbook: bid=0.65, ask=0.35 (инвертированный spread, что технически невалидно для orderbook, но проверяет логику)
      // Наша котировка: bid=0.39, ask=0.61 (валидный спред для котировки)
      // quote.bid (0.39) >= orderbookAsk (0.35) - bid пересекает
      // quote.ask (0.61) <= orderbookBid (0.65) - ask пересекает
      const doubleCrossingQuote = Quote.of(
        Price.of(new Decimal(0.39)), // наш bid >= orderbook ask (0.35)
        Price.of(new Decimal(0.61)), // наш ask <= orderbook bid (0.65)
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.65)); // высокий bid (quote.ask пересекает его)
      const orderbookAsk = Price.of(new Decimal(0.35)); // низкий ask (quote.bid пересекает его)

      const result = ValidateMarketCrossing.checkQuote(doubleCrossingQuote, orderbookBid, orderbookAsk);

      // Должна вернуться ошибка, проверяем какая сторона репортится первой
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
        // Проверяем что возвращается первая обнаруженная сторона (bid проверяется первым)
        expect(result.error.context?.side).toBe('bid');
      }
    });
  });

  describe('crossesMarket()', () => {
    it('returns true когда пересекает (bid side)', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.51)), // наш bid
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.50));
      const orderbookAsk = Price.of(new Decimal(0.51)); // наш bid >= orderbook ask

      const crosses = ValidateMarketCrossing.crossesMarket(quote, orderbookBid, orderbookAsk);

      expect(crosses).toBe(true);
    });

    it('returns true когда quoteAsk <= orderbookBid (ask side пересекает)', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.50)), // наш ask <= orderbook bid
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.50)); // наш ask <= orderbook bid
      const orderbookAsk = Price.of(new Decimal(0.51));

      const crosses = ValidateMarketCrossing.crossesMarket(quote, orderbookBid, orderbookAsk);

      expect(crosses).toBe(true);
    });

    it('returns false когда не пересекает', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.50));
      const orderbookAsk = Price.of(new Decimal(0.51));

      const crosses = ValidateMarketCrossing.crossesMarket(quote, orderbookBid, orderbookAsk);

      expect(crosses).toBe(false);
    });

    it('returns false когда ask не пересекает (non-crossing ask case)', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)), // наш ask > orderbook bid (0.50)
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(Date.now()),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      const orderbookBid = Price.of(new Decimal(0.50));
      const orderbookAsk = Price.of(new Decimal(0.51));

      const crosses = ValidateMarketCrossing.crossesMarket(quote, orderbookBid, orderbookAsk);

      expect(crosses).toBe(false);
    });
  });

  describe('check() - low-level API', () => {
    it('works с отдельными bid/ask вместо Quote (bid пересекает)', () => {
      const quoteBid = Price.of(new Decimal(0.51));
      const quoteAsk = Price.of(new Decimal(0.52));
      const orderbookBid = Price.of(new Decimal(0.50));
      const orderbookAsk = Price.of(new Decimal(0.51)); // quoteBid >= orderbookAsk

      const result = ValidateMarketCrossing.check(quoteBid, quoteAsk, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
      }
    });

    it('returns Ok когда ни одна сторона не пересекает (successful path)', () => {
      const quoteBid = Price.of(new Decimal(0.48));
      const quoteAsk = Price.of(new Decimal(0.52));
      const orderbookBid = Price.of(new Decimal(0.50));
      const orderbookAsk = Price.of(new Decimal(0.51));

      const result = ValidateMarketCrossing.check(quoteBid, quoteAsk, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(true);
    });

    it('returns Err когда ask-side пересекает (quoteAsk <= orderbookBid)', () => {
      const quoteBid = Price.of(new Decimal(0.48));
      const quoteAsk = Price.of(new Decimal(0.50)); // <= orderbookBid
      const orderbookBid = Price.of(new Decimal(0.50));
      const orderbookAsk = Price.of(new Decimal(0.51));

      const result = ValidateMarketCrossing.check(quoteBid, quoteAsk, orderbookBid, orderbookAsk);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.MARKET_CROSSING);
      }
    });
  });
});
