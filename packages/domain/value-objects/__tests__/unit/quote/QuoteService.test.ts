import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import type { MarketDataSourceId, InstrumentId } from '@polymarket/ids';
import { QuoteService } from '../../../src/quote/facade/QuoteService.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { PaperClock } from '@polymarket/time';

// Тестовые константы для sourceId и instrumentId
const TEST_SOURCE_ID = 'TEST_SOURCE' as MarketDataSourceId;
const TEST_INSTRUMENT_ID = 'TEST_INSTRUMENT' as InstrumentId;
import { QuoteErrorReason } from '../../../src/quote/errors/QuoteErrorReason.js';

describe('QuoteService', () => {
  describe('create()', () => {
    it('создаёт валидную двустороннюю котировку', () => {
      const result = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const quote = result.value;
        expect(quote.bid()?.value().toNumber()).toBe(0.48);
        expect(quote.ask()?.value().toNumber()).toBe(0.52);
        expect(quote.bidSize().value().toNumber()).toBe(100);
        expect(quote.askSize().value().toNumber()).toBe(150);
        expect(quote.isTwoSided()).toBe(true);
      }
    });

    it('создаёт котировку с timestamp', () => {
      const timestamp = Date.now();
      const result = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID, timestamp);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.timestampMs().toNumber()).toBe(timestamp);
      }
    });

    it('фэйлится с invalid bid (parse error)', () => {
      const result = QuoteService.create('invalid' as any, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.context?.raw).toEqual({ field: 'bidValue', value: 'invalid' });
        // component не нужен - информация уже в raw.field
      }
    });

    it('фэйлится с invalid ask (parse error)', () => {
      const result = QuoteService.create(0.48, 'invalid' as any, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.context?.raw).toEqual({ field: 'askValue', value: 'invalid' });
      }
    });

    it('фэйлится с invalid bidSize (parse error)', () => {
      const result = QuoteService.create(0.48, 0.52, 'invalid' as any, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.context?.raw).toEqual({ field: 'bidSizeValue', value: 'invalid' });
      }
    });

    it('фэйлится с invalid askSize (parse error)', () => {
      const result = QuoteService.create(0.48, 0.52, 100, 'invalid' as any, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.context?.raw).toEqual({ field: 'askSizeValue', value: 'invalid' });
      }
    });

    it('фэйлится когда обе стороны null (invariant)', () => {
      const result = QuoteService.create(null, null, 0, 0, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.BOTH_SIDES_NULL);
      }
    });

    it('фэйлится когда bid > ask (invariant)', () => {
      const result = QuoteService.create(0.60, 0.40, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.BID_GREATER_THAN_ASK);
      }
    });

    it('фэйлится когда bid price вне диапазона', () => {
      const result = QuoteService.create(1.5, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID); // bid > MAX_PRICE

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // reason содержит корневую причину из PriceService (OUT_OF_RANGE_HIGH)
        // component показывает какое поле не прошло валидацию
        expect(result.error.context?.component).toBe('bid');
      }
    });

    it('фэйлится когда ask price вне диапазона', () => {
      const result = QuoteService.create(0.48, 0.00005, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID); // ask < MIN_PRICE

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // reason содержит корневую причину из PriceService (OUT_OF_RANGE_LOW)
        // component показывает какое поле не прошло валидацию
        expect(result.error.context?.component).toBe('ask');
      }
    });

    it('фэйлится когда bidSize отрицательный', () => {
      const result = QuoteService.create(0.48, 0.52, -100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // reason содержит корневую причину из QuantityService (NEGATIVE)
        // component показывает какое поле не прошло валидацию
        expect(result.error.context?.component).toBe('bidSize');
      }
    });

    it('фэйлится когда askSize отрицательный', () => {
      const result = QuoteService.create(0.48, 0.52, 100, -150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // reason содержит корневую причину из QuantityService (NEGATIVE)
        // component показывает какое поле не прошло валидацию
        expect(result.error.context?.component).toBe('askSize');
      }
    });

    it('возвращает Err для invalid timestamp (non-parseable string)', () => {
      const result = QuoteService.create(
        0.48, 0.52, 100, 150,
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID,
        'invalid-timestamp' as any
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Parse-error branch покрыт (parseDecimal возвращает Err)
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
      }
    });
  });

  describe('create() с Decimal parameters', () => {
    it('создаёт котировку из Decimal значений', () => {
      const result = QuoteService.create(
        new Decimal(0.48),
        new Decimal(0.52),
        new Decimal(100),
        new Decimal(150),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isTwoSided()).toBe(true);
      }
    });

    it('создаёт bid-only котировку', () => {
      const result = QuoteService.create(
        new Decimal(0.50),
        null,
        new Decimal(100),
        new Decimal(0),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasBid()).toBe(true);
        expect(result.value.hasAsk()).toBe(false);
      }
    });

    it('создаёт ask-only котировку', () => {
      const result = QuoteService.create(
        null,
        new Decimal(0.51),
        new Decimal(0),
        new Decimal(200),
        TEST_SOURCE_ID,
        TEST_INSTRUMENT_ID
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasBid()).toBe(false);
        expect(result.value.hasAsk()).toBe(true);
      }
    });
  });

  describe('bidOnly()', () => {
    it('создаёт bid-only котировку из number', () => {
      const result = QuoteService.bidOnly(0.50, 100, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const quote = result.value;
        expect(quote.hasBid()).toBe(true);
        expect(quote.hasAsk()).toBe(false);
        expect(quote.bid()?.value().toNumber()).toBe(0.50);
        expect(quote.bidSize().value().toNumber()).toBe(100);
        expect(quote.askSize().value().toNumber()).toBe(0);
      }
    });

    it('создаёт bid-only котировку из Decimal', () => {
      const result = QuoteService.bidOnly(new Decimal(0.50), new Decimal(100), TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasBid()).toBe(true);
      }
    });

    it('фэйлится с invalid bid', () => {
      const result = QuoteService.bidOnly('invalid' as any, 100, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
      }
    });

    it('фэйлится с invalid size', () => {
      const result = QuoteService.bidOnly(0.50, 'invalid' as any, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
      }
    });
  });

  describe('askOnly()', () => {
    it('создаёт ask-only котировку из number', () => {
      const result = QuoteService.askOnly(0.51, 200, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const quote = result.value;
        expect(quote.hasBid()).toBe(false);
        expect(quote.hasAsk()).toBe(true);
        expect(quote.ask()?.value().toNumber()).toBe(0.51);
        expect(quote.askSize().value().toNumber()).toBe(200);
        expect(quote.bidSize().value().toNumber()).toBe(0);
      }
    });

    it('создаёт ask-only котировку из Decimal', () => {
      const result = QuoteService.askOnly(new Decimal(0.51), new Decimal(200), TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasAsk()).toBe(true);
      }
    });

    it('фэйлится с invalid ask', () => {
      const result = QuoteService.askOnly('invalid' as any, 200, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
      }
    });

    it('фэйлится с invalid size', () => {
      const result = QuoteService.askOnly(0.51, 'invalid' as any, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
      }
    });
  });

  describe('shift()', () => {
    it('сдвигает котировку вверх', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const shiftResult = QuoteService.shift(quoteResult.value, new Decimal(0.01));

      expect(shiftResult.ok).toBe(true);
      if (shiftResult.ok) {
        const shifted = shiftResult.value;
        expect(shifted.bid()?.value().toNumber()).toBeCloseTo(0.49, 10);
        expect(shifted.ask()?.value().toNumber()).toBeCloseTo(0.53, 10);
        // Spread остался прежним
        expect(shifted.spread()?.width().toNumber()).toBeCloseTo(0.04, 10);
      }
    });

    it('сдвигает котировку вниз', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const shiftResult = QuoteService.shift(quoteResult.value, new Decimal(-0.01));

      expect(shiftResult.ok).toBe(true);
      if (shiftResult.ok) {
        const shifted = shiftResult.value;
        expect(shifted.bid()?.value().toNumber()).toBeCloseTo(0.47, 10);
        expect(shifted.ask()?.value().toNumber()).toBeCloseTo(0.51, 10);
      }
    });

    it('сдвигает bid-only котировку', () => {
      const quoteResult = QuoteService.bidOnly(0.50, 100, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const shiftResult = QuoteService.shift(quoteResult.value, new Decimal(0.01));

      expect(shiftResult.ok).toBe(true);
      if (shiftResult.ok) {
        const shifted = shiftResult.value;
        expect(shifted.bid()?.value().toNumber()).toBeCloseTo(0.51, 10);
        expect(shifted.hasAsk()).toBe(false);
      }
    });

    it('фэйлится когда shift вверх выходит за MAX_PRICE', () => {
      const quoteResult = QuoteService.create(0.98, 0.99, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const shiftResult = QuoteService.shift(quoteResult.value, new Decimal(0.10));

      expect(shiftResult.ok).toBe(false);
      if (!shiftResult.ok) {
        // bid становится 1.08, что превышает MAX_PRICE (0.9999)
        // reason содержит корневую причину из PriceService (OUT_OF_RANGE_HIGH)
        // component показывает какое поле не прошло валидацию
        expect(shiftResult.error.context?.component).toBe('bid');
        expect(shiftResult.error.context?.op).toBe('shift');
      }
    });

    it('фэйлится когда shift вниз выходит за MIN_PRICE', () => {
      const quoteResult = QuoteService.create(0.001, 0.002, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const shiftResult = QuoteService.shift(quoteResult.value, new Decimal(-0.001));

      expect(shiftResult.ok).toBe(false);
      if (!shiftResult.ok) {
        // bid становится 0, что ниже MIN_PRICE (0.0001)
        // reason содержит корневую причину из PriceService (OUT_OF_RANGE_LOW)
        // component показывает какое поле не прошло валидацию
        expect(shiftResult.error.context?.component).toBe('bid');
        expect(shiftResult.error.context?.op).toBe('shift');
      }
    });

    it('сохраняет sizes при shift', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const shiftResult = QuoteService.shift(quoteResult.value, new Decimal(0.01));

      expect(shiftResult.ok).toBe(true);
      if (shiftResult.ok) {
        expect(shiftResult.value.bidSize().value().toNumber()).toBe(100);
        expect(shiftResult.value.askSize().value().toNumber()).toBe(150);
      }
    });

    it('возвращает Err для invalid shiftAmount (non-parseable string)', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      if (!quoteResult.ok) return;

      const result = QuoteService.shift(quoteResult.value, 'invalid' as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Parse-error branch покрыт (parseDecimal для shiftAmount возвращает Err)
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
      }
    });
  });

  describe('skew()', () => {
    it('применяет skew к котировке', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const skewResult = QuoteService.skew(
        quoteResult.value,
        new Decimal(-0.01), // bid вниз
        new Decimal(0.01)   // ask вверх
      );

      expect(skewResult.ok).toBe(true);
      if (skewResult.ok) {
        const skewed = skewResult.value;
        expect(skewed.bid()?.value().toNumber()).toBeCloseTo(0.47, 10);
        expect(skewed.ask()?.value().toNumber()).toBeCloseTo(0.53, 10);
        // Spread увеличился
        expect(skewed.spread()?.width().toNumber()).toBeCloseTo(0.06, 10);
      }
    });

    it('применяет skew только к bid', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const skewResult = QuoteService.skew(
        quoteResult.value,
        new Decimal(-0.01), // bid вниз
        new Decimal(0)      // ask не меняется
      );

      expect(skewResult.ok).toBe(true);
      if (skewResult.ok) {
        const skewed = skewResult.value;
        expect(skewed.bid()?.value().toNumber()).toBeCloseTo(0.47, 10);
        expect(skewed.ask()?.value().toNumber()).toBeCloseTo(0.52, 10);
      }
    });

    it('применяет skew только к ask', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const skewResult = QuoteService.skew(
        quoteResult.value,
        new Decimal(0),    // bid не меняется
        new Decimal(0.01)  // ask вверх
      );

      expect(skewResult.ok).toBe(true);
      if (skewResult.ok) {
        const skewed = skewResult.value;
        expect(skewed.bid()?.value().toNumber()).toBeCloseTo(0.48, 10);
        expect(skewed.ask()?.value().toNumber()).toBeCloseTo(0.53, 10);
      }
    });

    it('фэйлится когда skew создаёт bid > ask', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const skewResult = QuoteService.skew(
        quoteResult.value,
        new Decimal(0.10),  // bid вверх сильно
        new Decimal(-0.10)  // ask вниз сильно
      );

      expect(skewResult.ok).toBe(false);
      if (!skewResult.ok) {
        expect(skewResult.error.context?.reason).toBe(QuoteErrorReason.BID_GREATER_THAN_ASK);
      }
    });

    it('фэйлится когда skew выходит за нижнюю границу', () => {
      const quoteResult = QuoteService.create(0.0005, 0.001, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const skewResult = QuoteService.skew(
        quoteResult.value,
        new Decimal(-0.001),  // bid вниз за MIN_PRICE
        new Decimal(0)
      );

      expect(skewResult.ok).toBe(false);
      if (!skewResult.ok) {
        // bid становится -0.0005, что ниже MIN_PRICE (0.0001)
        // reason содержит корневую причину из PriceService (OUT_OF_RANGE_LOW)
        // component показывает какое поле не прошло валидацию
        expect(skewResult.error.context?.component).toBe('bid');
        expect(skewResult.error.context?.op).toBe('skew');
      }
    });

    it('фэйлится когда skew выходит за верхнюю границу', () => {
      const quoteResult = QuoteService.create(0.98, 0.99, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const skewResult = QuoteService.skew(
        quoteResult.value,
        new Decimal(0),
        new Decimal(0.10)  // ask вверх за MAX_PRICE
      );

      expect(skewResult.ok).toBe(false);
      if (!skewResult.ok) {
        // ask становится 1.09, что выше MAX_PRICE (0.9999)
        // reason содержит корневую причину из PriceService (OUT_OF_RANGE_HIGH)
        // component показывает какое поле не прошло валидацию
        expect(skewResult.error.context?.component).toBe('ask');
        expect(skewResult.error.context?.op).toBe('skew');
      }
    });

    it('возвращает Err для invalid bidAdjustment (non-parseable string)', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      if (!quoteResult.ok) return;

      const result = QuoteService.skew(quoteResult.value, 'invalid' as any, new Decimal(0));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Parse-error branch покрыт (parseDecimal для bidAdjustment возвращает Err)
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
      }
    });

    it('возвращает Err для invalid askAdjustment (non-parseable string)', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      if (!quoteResult.ok) return;

      const result = QuoteService.skew(quoteResult.value, new Decimal(0), 'invalid' as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Parse-error branch покрыт (parseDecimal для askAdjustment возвращает Err)
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
      }
    });
  });

  describe('updateSizes()', () => {
    it('обновляет sizes из number', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const updateResult = QuoteService.updateSizes(quoteResult.value, 200, 300);

      expect(updateResult.ok).toBe(true);
      if (updateResult.ok) {
        const updated = updateResult.value;
        expect(updated.bidSize().value().toNumber()).toBe(200);
        expect(updated.askSize().value().toNumber()).toBe(300);
        // Prices не изменились
        expect(updated.bid()?.value().toNumber()).toBe(0.48);
        expect(updated.ask()?.value().toNumber()).toBe(0.52);
      }
    });

    it('обновляет sizes из Quantity', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const updateResult = QuoteService.updateSizes(
        quoteResult.value,
        Quantity.of(new Decimal(200)),
        Quantity.of(new Decimal(300))
      );

      expect(updateResult.ok).toBe(true);
      if (updateResult.ok) {
        expect(updateResult.value.bidSize().value().toNumber()).toBe(200);
        expect(updateResult.value.askSize().value().toNumber()).toBe(300);
      }
    });

    it('обновляет sizes из string', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const updateResult = QuoteService.updateSizes(quoteResult.value, '200', '300');

      expect(updateResult.ok).toBe(true);
      if (updateResult.ok) {
        expect(updateResult.value.bidSize().value().toNumber()).toBe(200);
        expect(updateResult.value.askSize().value().toNumber()).toBe(300);
      }
    });

    it('обновляет sizes из Decimal', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const updateResult = QuoteService.updateSizes(
        quoteResult.value,
        new Decimal(200),
        new Decimal(300)
      );

      expect(updateResult.ok).toBe(true);
      if (updateResult.ok) {
        expect(updateResult.value.bidSize().value().toNumber()).toBe(200);
        expect(updateResult.value.askSize().value().toNumber()).toBe(300);
      }
    });

    it('фэйлится с invalid bidSize', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const updateResult = QuoteService.updateSizes(quoteResult.value, -100, 300);

      expect(updateResult.ok).toBe(false);
      if (!updateResult.ok) {
        // reason содержит корневую причину из QuantityService (NEGATIVE)
        // component показывает какое поле не прошло валидацию
        expect(updateResult.error.context?.component).toBe('bidSize');
      }
    });

    it('фэйлится с invalid askSize', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const updateResult = QuoteService.updateSizes(quoteResult.value, 200, -300);

      expect(updateResult.ok).toBe(false);
      if (!updateResult.ok) {
        // reason содержит корневую причину из QuantityService (NEGATIVE)
        // component показывает какое поле не прошло валидацию
        expect(updateResult.error.context?.component).toBe('askSize');
      }
    });

    it('фэйлится при попытке установить non-zero size на null стороне (bid-only)', () => {
      // Создаём bid-only котировку
      const bidOnlyResult = QuoteService.bidOnly(0.50, 100, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(bidOnlyResult.ok).toBe(true);
      if (!bidOnlyResult.ok) return;

      // Пытаемся установить non-zero askSize при отсутствии ask
      const updateResult = QuoteService.updateSizes(bidOnlyResult.value, 100, 200);

      expect(updateResult.ok).toBe(false);
      if (!updateResult.ok) {
        // QuoteInvariantViolation catch branch (line 817)
        expect(updateResult.error.context?.source).toBe('core_invariant');
        expect(updateResult.error.context?.reason).toBe('INCONSISTENT_ASK_SIZE');
      }
    });

    it('фэйлится при попытке установить non-zero size на null стороне (ask-only)', () => {
      // Создаём ask-only котировку
      const askOnlyResult = QuoteService.askOnly(0.51, 200, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(askOnlyResult.ok).toBe(true);
      if (!askOnlyResult.ok) return;

      // Пытаемся установить non-zero bidSize при отсутствии bid
      const updateResult = QuoteService.updateSizes(askOnlyResult.value, 150, 200);

      expect(updateResult.ok).toBe(false);
      if (!updateResult.ok) {
        // QuoteInvariantViolation catch branch (line 817)
        expect(updateResult.error.context?.source).toBe('core_invariant');
        expect(updateResult.error.context?.reason).toBe('INCONSISTENT_BID_SIZE');
      }
    });
  });

  describe('spreadWidthOrZero() (from Quote)', () => {
    it('возвращает spread для two-sided quote', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const spread = quoteResult.value.spreadWidthOrZero();

      expect(spread.toNumber()).toBe(0.04);
    });

    it('возвращает 0 для bid-only quote', () => {
      const quoteResult = QuoteService.bidOnly(0.50, 100, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const spread = quoteResult.value.spreadWidthOrZero();

      expect(spread.toNumber()).toBe(0);
    });

    it('возвращает 0 для ask-only quote', () => {
      const quoteResult = QuoteService.askOnly(0.51, 200, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const spread = quoteResult.value.spreadWidthOrZero();

      expect(spread.toNumber()).toBe(0);
    });
  });

  describe('midOrNull() (from Quote)', () => {
    it('возвращает mid для two-sided quote', () => {
      const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const mid = quoteResult.value.midOrNull();

      expect(mid).not.toBeNull();
      expect(mid?.toNumber()).toBe(0.50);
    });

    it('возвращает null для bid-only quote', () => {
      const quoteResult = QuoteService.bidOnly(0.50, 100, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const mid = quoteResult.value.midOrNull();

      expect(mid).toBeNull();
    });

    it('возвращает null для ask-only quote', () => {
      const quoteResult = QuoteService.askOnly(0.51, 200, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
      expect(quoteResult.ok).toBe(true);
      if (!quoteResult.ok) return;

      const mid = quoteResult.value.midOrNull();

      expect(mid).toBeNull();
    });
  });

  describe('WithRefresh methods (timestamp update)', () => {
    describe('shiftWithRefresh()', () => {
      it('сдвигает quote и обновляет timestamp', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID, 1000);
        expect(quoteResult.ok).toBe(true);
        if (!quoteResult.ok) return;
        const quote = quoteResult.value;

        const result = QuoteService.shiftWithRefresh(quote, new Decimal(0.10), clock);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid()?.value().toNumber()).toBeCloseTo(0.58);
          expect(result.value.ask()?.value().toNumber()).toBeCloseTo(0.62);
          expect(result.value.timestampMs().toNumber()).toBe(clock.now().getTime());
          expect(result.value.timestampMs().toNumber()).not.toBe(1000);
        }
      });

      it('работает с bid-only quote (сдвигает только bid)', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const quoteResult = QuoteService.bidOnly(0.50, 100, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
        expect(quoteResult.ok).toBe(true);
        if (!quoteResult.ok) return;

        const result = QuoteService.shiftWithRefresh(quoteResult.value, new Decimal(0.05), clock);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid()?.value().toNumber()).toBeCloseTo(0.55);
          expect(result.value.ask()).toBeNull();
          expect(result.value.timestampMs().toNumber()).toBe(clock.now().getTime());
        }
      });

      it('возвращает Err для invalid shiftAmount (non-parseable string)', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
        if (!quoteResult.ok) return;

        const result = QuoteService.shiftWithRefresh(quoteResult.value, 'invalid' as any, clock);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          // Parse-error branch покрыт (parseDecimal для shiftAmount возвращает Err)
          expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        }
      });
    });

    describe('skewWithRefresh()', () => {
      it('наклоняет quote и обновляет timestamp', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID, 1000);
        expect(quoteResult.ok).toBe(true);
        if (!quoteResult.ok) return;
        const quote = quoteResult.value;

        const result = QuoteService.skewWithRefresh(quote, new Decimal(0.02), new Decimal(-0.01), clock);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid()?.value().toNumber()).toBeCloseTo(0.50);
          expect(result.value.ask()?.value().toNumber()).toBeCloseTo(0.51);
          expect(result.value.timestampMs().toNumber()).toBe(clock.now().getTime());
          expect(result.value.timestampMs().toNumber()).not.toBe(1000);
        }
      });

      it('работает с bid-only quote (наклоняет только bid)', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const quoteResult = QuoteService.bidOnly(0.50, 100, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
        expect(quoteResult.ok).toBe(true);
        if (!quoteResult.ok) return;

        const result = QuoteService.skewWithRefresh(quoteResult.value, new Decimal(0.02), new Decimal(-0.01), clock);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid()?.value().toNumber()).toBeCloseTo(0.52);
          expect(result.value.ask()).toBeNull();
        }
      });

      it('возвращает Err для invalid bidAdjustment (non-parseable string)', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
        if (!quoteResult.ok) return;

        const result = QuoteService.skewWithRefresh(quoteResult.value, 'invalid' as any, new Decimal(0), clock);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          // Parse-error branch покрыт (parseDecimal для bidAdjustment возвращает Err)
          expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        }
      });

      it('возвращает Err для invalid askAdjustment (non-parseable string)', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
        if (!quoteResult.ok) return;

        const result = QuoteService.skewWithRefresh(quoteResult.value, new Decimal(0), 'invalid' as any, clock);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          // Parse-error branch покрыт (parseDecimal для askAdjustment возвращает Err)
          expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        }
      });
    });

    describe('updateSizesWithRefresh()', () => {
      it('обновляет sizes и timestamp', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID, 1000);
        expect(quoteResult.ok).toBe(true);
        if (!quoteResult.ok) return;
        const quote = quoteResult.value;

        const result = QuoteService.updateSizesWithRefresh(quote, 200, 300, clock);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bidSize().value().toNumber()).toBe(200);
          expect(result.value.askSize().value().toNumber()).toBe(300);
          expect(result.value.timestampMs().toNumber()).toBe(clock.now().getTime());
          expect(result.value.timestampMs().toNumber()).not.toBe(1000);
        }
      });

      it('работает с Quantity объектами', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
        expect(quoteResult.ok).toBe(true);
        if (!quoteResult.ok) return;

        const result = QuoteService.updateSizesWithRefresh(
          quoteResult.value,
          Quantity.of(new Decimal(250)),
          Quantity.of(new Decimal(350)),
          clock
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bidSize().value().toNumber()).toBe(250);
          expect(result.value.askSize().value().toNumber()).toBe(350);
        }
      });

      it('возвращает Err для невалидного bidSize', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
        expect(quoteResult.ok).toBe(true);
        if (!quoteResult.ok) return;

        const result = QuoteService.updateSizesWithRefresh(quoteResult.value, -100, 200, clock);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.component).toBe('bidSize');
          // Rewrap branch покрыт (QuantityService.create для bidSize возвращает Err)
        }
      });

      it('возвращает Err для невалидного askSize', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
        expect(quoteResult.ok).toBe(true);
        if (!quoteResult.ok) return;

        const result = QuoteService.updateSizesWithRefresh(quoteResult.value, 200, -150, clock);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.component).toBe('askSize');
          // Rewrap branch покрыт (QuantityService.create для askSize возвращает Err)
        }
      });

      it('фэйлится при попытке установить non-zero size на null стороне (bid-only)', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const bidOnlyResult = QuoteService.bidOnly(0.50, 100, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
        expect(bidOnlyResult.ok).toBe(true);
        if (!bidOnlyResult.ok) return;

        // Пытаемся установить non-zero askSize при отсутствии ask
        const result = QuoteService.updateSizesWithRefresh(bidOnlyResult.value, 100, 200, clock);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          // QuoteInvariantViolation catch branch (line 946)
          expect(result.error.context?.source).toBe('core_invariant');
          expect(result.error.context?.reason).toBe('INCONSISTENT_ASK_SIZE');
        }
      });

      it('фэйлится при попытке установить non-zero size на null стороне (ask-only)', () => {
        const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
        const askOnlyResult = QuoteService.askOnly(0.51, 200, TEST_SOURCE_ID, TEST_INSTRUMENT_ID);
        expect(askOnlyResult.ok).toBe(true);
        if (!askOnlyResult.ok) return;

        // Пытаемся установить non-zero bidSize при отсутствии bid
        const result = QuoteService.updateSizesWithRefresh(askOnlyResult.value, 150, 200, clock);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          // QuoteInvariantViolation catch branch (line 946)
          expect(result.error.context?.source).toBe('core_invariant');
          expect(result.error.context?.reason).toBe('INCONSISTENT_BID_SIZE');
        }
      });
    });
  });
});
