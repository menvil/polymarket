import { describe, it, expect } from '@jest/globals';
import { QuoteService } from '../../../src/quote/facade/QuoteService.js';
import { QuoteSerializer } from '../../../src/quote/adapters/QuoteSerializer.js';
import { QuoteFormatter } from '../../../src/quote/adapters/QuoteFormatter.js';
import { QuoteErrorReason } from '../../../src/quote/errors/QuoteErrorReason.js';
import { ValidateMarketCrossing } from '../../../src/quote/rules/ValidateMarketCrossing.js';
import { Price } from '../../../src/price/core/Price.js';
import Decimal from 'decimal.js';

describe('Quote Integration Tests', () => {
  describe('Market making workflow', () => {
    it('создание → shift → skew → update sizes', () => {
      // Шаг 1: Создаём начальную котировку
      const createResult = QuoteService.create(0.48, 0.52, 100, 150);
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const quote1 = createResult.value;
      expect(quote1.bid()?.value().toNumber()).toBe(0.48);
      expect(quote1.ask()?.value().toNumber()).toBe(0.52);
      expect(quote1.isTwoSided()).toBe(true);

      // Шаг 2: Сдвигаем вверх (рынок вырос)
      const shiftResult = QuoteService.shift(quote1, new Decimal(0.01));
      expect(shiftResult.ok).toBe(true);
      if (!shiftResult.ok) return;

      const quote2 = shiftResult.value;
      expect(quote2.bid()?.value().toNumber()).toBe(0.49);
      expect(quote2.ask()?.value().toNumber()).toBe(0.53);

      // Шаг 3: Применяем skew (расширяем spread)
      const skewResult = QuoteService.skew(
        quote2,
        new Decimal(-0.01), // bid вниз
        new Decimal(0.01)   // ask вверх
      );
      expect(skewResult.ok).toBe(true);
      if (!skewResult.ok) return;

      const quote3 = skewResult.value;
      expect(quote3.bid()?.value().toNumber()).toBe(0.48);
      expect(quote3.ask()?.value().toNumber()).toBe(0.54);
      expect(quote3.spreadWidth()?.toNumber()).toBe(0.06);

      // Шаг 4: Обновляем размеры
      const updateResult = QuoteService.updateSizes(quote3, 200, 250);
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;

      const quote4 = updateResult.value;
      expect(quote4.bidSize().value().toNumber()).toBe(200);
      expect(quote4.askSize().value().toNumber()).toBe(250);

      // Проверяем immutability - оригиналы не изменились
      expect(quote1.bid()?.value().toNumber()).toBe(0.48);
      expect(quote1.bidSize().value().toNumber()).toBe(100);
      expect(quote2.bid()?.value().toNumber()).toBe(0.49);
      expect(quote3.bid()?.value().toNumber()).toBe(0.48);
    });

    it('односторонние котировки: bid only → ask only', () => {
      // Создаём bid-only
      const bidResult = QuoteService.bidOnly(0.50, 100);
      expect(bidResult.ok).toBe(true);
      if (!bidResult.ok) return;

      const bidQuote = bidResult.value;
      expect(bidQuote.hasBid()).toBe(true);
      expect(bidQuote.hasAsk()).toBe(false);
      expect(bidQuote.isTwoSided()).toBe(false);
      expect(bidQuote.spreadWidth()).toBeNull();
      expect(bidQuote.midPrice()).toBeNull();

      // Создаём ask-only
      const askResult = QuoteService.askOnly(0.51, 150);
      expect(askResult.ok).toBe(true);
      if (!askResult.ok) return;

      const askQuote = askResult.value;
      expect(askQuote.hasBid()).toBe(false);
      expect(askQuote.hasAsk()).toBe(true);
      expect(askQuote.isTwoSided()).toBe(false);
    });

    it('вычисление spread метрик на всех этапах', () => {
      // Создаём котировку
      const result = QuoteService.create(0.48, 0.52, 100, 150);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const quote = result.value;

      // Spread width
      const spread = quote.spreadWidth();
      expect(spread).not.toBeNull();
      expect(spread!.toNumber()).toBe(0.04);

      // Mid price
      const mid = quote.midPrice();
      expect(mid).not.toBeNull();
      expect(mid!.value().toNumber()).toBe(0.50);

      // Spread percentage
      const spreadPct = quote.spreadPercentage();
      expect(spreadPct).not.toBeNull();
      expect(spreadPct!.toNumber()).toBe(8); // 0.04 / 0.50 * 100 = 8%
    });

    it('market crossing detection', () => {
      // Создаём котировку
      const result = QuoteService.create(0.48, 0.52, 100, 150);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const quote = result.value;

      // Нормальная ситуация - не пересекается
      const doesNotCross = ValidateMarketCrossing.crossesMarket(
        quote,
        Price.of(0.47), // orderbook bid
        Price.of(0.53)  // orderbook ask
      );
      expect(doesNotCross).toBe(false);

      // Наш bid >= orderbook ask - пересечение!
      const crossesBid = ValidateMarketCrossing.crossesMarket(
        quote,
        Price.of(0.47),
        Price.of(0.48)  // наш bid 0.48 >= orderbook ask 0.48
      );
      expect(crossesBid).toBe(true);

      // Наш ask <= orderbook bid - пересечение!
      const crossesAsk = ValidateMarketCrossing.crossesMarket(
        quote,
        Price.of(0.52),  // наш ask 0.52 <= orderbook bid 0.52
        Price.of(0.53)
      );
      expect(crossesAsk).toBe(true);
    });
  });

  describe('Serialization round-trip', () => {
    it('toJSON → fromJSON сохраняет two-sided quote', () => {
      // Создаём оригинальную котировку
      const originalResult = QuoteService.create(0.48, 0.52, 100, 150);
      expect(originalResult.ok).toBe(true);
      if (!originalResult.ok) return;

      const original = originalResult.value;

      // Сериализуем
      const json = QuoteSerializer.toJSON(original);
      expect(json).toEqual({
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        timestamp: original.timestampMs()
      });

      // Десериализуем
      const deserializedResult = QuoteSerializer.fromJSON(json);
      expect(deserializedResult.ok).toBe(true);
      if (!deserializedResult.ok) return;

      const deserialized = deserializedResult.value;

      // Проверяем идентичность
      expect(deserialized.bid()?.value().toNumber()).toBe(0.48);
      expect(deserialized.ask()?.value().toNumber()).toBe(0.52);
      expect(deserialized.bidSize().value().toNumber()).toBe(100);
      expect(deserialized.askSize().value().toNumber()).toBe(150);
      expect(deserialized.timestampMs()).toBe(original.timestampMs());
    });

    it('toJSON → fromJSON сохраняет one-sided quote', () => {
      // Bid-only
      const bidResult = QuoteService.bidOnly(0.50, 100);
      expect(bidResult.ok).toBe(true);
      if (!bidResult.ok) return;

      const bidQuote = bidResult.value;
      const bidJson = QuoteSerializer.toJSON(bidQuote);

      expect(bidJson.bid).toBe(0.5);
      expect(bidJson.ask).toBeNull();

      const bidDeserResult = QuoteSerializer.fromJSON(bidJson);
      expect(bidDeserResult.ok).toBe(true);
      if (!bidDeserResult.ok) return;

      expect(bidDeserResult.value.hasBid()).toBe(true);
      expect(bidDeserResult.value.hasAsk()).toBe(false);
    });

    it('сохраняет Quote через serialization/deserialization', () => {
      // Используем значения с высокой точностью
      const result = QuoteService.create(
        0.123456789012345,
        0.987654321098765,
        100.123456,
        200.654321
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const quote = result.value;
      const json = QuoteSerializer.toJSON(quote);

      // Проверяем что используется number
      expect(typeof json.bid).toBe('number');
      expect(typeof json.ask).toBe('number');
      expect(typeof json.bidSize).toBe('number');
      expect(typeof json.askSize).toBe('number');

      // Десериализуем и проверяем что значения близки
      // (может быть потеря точности из-за JSON number)
      const deserResult = QuoteSerializer.fromJSON(json);
      expect(deserResult.ok).toBe(true);
      if (!deserResult.ok) return;

      const deserialized = deserResult.value;
      expect(deserialized.bid()!.value().toNumber()).toBeCloseTo(
        quote.bid()!.value().toNumber(),
        10
      );
      expect(deserialized.ask()!.value().toNumber()).toBeCloseTo(
        quote.ask()!.value().toNumber(),
        10
      );
    });
  });

  describe('Formatter integration', () => {
    it('форматирует two-sided quote в short format', () => {
      const result = QuoteService.create(0.48, 0.52, 100, 150);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const formatted = QuoteFormatter.toShort(result.value);
      expect(formatted).toContain('0.48');
      expect(formatted).toContain('0.52');
    });

    it('форматирует two-sided quote в display format', () => {
      const result = QuoteService.create(0.48, 0.52, 100, 150);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const formatted = QuoteFormatter.toDisplay(result.value);
      expect(formatted).toContain('100');
      expect(formatted).toContain('150');
    });

    it('форматирует quote в detailed format', () => {
      const result = QuoteService.create(0.48, 0.52, 100, 150);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const formatted = QuoteFormatter.toDetailed(result.value);
      expect(formatted).toBeDefined();
      expect(typeof formatted).toBe('string');
    });
  });

  describe('Error handling', () => {
    it('возвращает ошибку BID_GREATER_THAN_ASK', () => {
      const result = QuoteService.create(
        0.52,  // bid
        0.48,  // ask (меньше bid!)
        100,
        150
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(
          QuoteErrorReason.BID_GREATER_THAN_ASK
        );
        // op будет 'create', потому что create() вызывает createFromDecimals()
        expect(result.error.context?.op).toBe('create');
      }
    });

    it('возвращает ошибку BOTH_SIDES_NULL', () => {
      const result = QuoteService.createFromDecimals(
        null, // bid
        null, // ask
        new Decimal(100),
        new Decimal(150)
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(
          QuoteErrorReason.BOTH_SIDES_NULL
        );
      }
    });

    it('возвращает ошибку INVALID_BID для невалидных значений bid', () => {
      const result = QuoteService.create(
        NaN,  // невалидный bid
        0.52,
        100,
        150
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // toDecimal вернет INVALID_FORMAT, но затем это оборачивается в INVALID_BID
        expect(result.error.context?.reason).toBe(
          QuoteErrorReason.INVALID_BID
        );
      }
    });

    it('проверяет Facade Error Contract', () => {
      const result = QuoteService.create(
        0.52,
        0.48, // bid > ask
        100,
        150
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Проверяем наличие полей context
        expect(result.error.context).toBeDefined();
        expect(result.error.context?.op).toBe('create');
        expect(result.error.context?.reason).toBeDefined();
        expect(result.error.context?.reason).toBe(QuoteErrorReason.BID_GREATER_THAN_ASK);
      }
    });
  });

  describe('Immutability contract', () => {
    it('все операции возвращают новые экземпляры', () => {
      const result1 = QuoteService.create(0.48, 0.52, 100, 150);
      expect(result1.ok).toBe(true);
      if (!result1.ok) return;

      const quote1 = result1.value;

      // shift
      const result2 = QuoteService.shift(quote1, new Decimal(0.01));
      expect(result2.ok).toBe(true);
      if (!result2.ok) return;

      const quote2 = result2.value;
      expect(quote2).not.toBe(quote1);
      expect(quote1.bid()?.value().toNumber()).toBe(0.48); // не изменился

      // skew
      const result3 = QuoteService.skew(
        quote1,
        new Decimal(-0.01),
        new Decimal(0.01)
      );
      expect(result3.ok).toBe(true);
      if (!result3.ok) return;

      const quote3 = result3.value;
      expect(quote3).not.toBe(quote1);

      // updateSizes
      const result4 = QuoteService.updateSizes(quote1, 200, 250);
      expect(result4.ok).toBe(true);
      if (!result4.ok) return;

      const quote4 = result4.value;
      expect(quote4).not.toBe(quote1);
      expect(quote1.bidSize().value().toNumber()).toBe(100); // не изменился
    });
  });

  describe('Query методы в workflow', () => {
    it('getSpreadOrZero возвращает 0 для one-sided', () => {
      const bidResult = QuoteService.bidOnly(0.50, 100);
      expect(bidResult.ok).toBe(true);
      if (!bidResult.ok) return;

      const spread = QuoteService.getSpreadOrZero(bidResult.value);
      expect(spread.toNumber()).toBe(0);

      const twoSidedResult = QuoteService.create(0.48, 0.52, 100, 150);
      expect(twoSidedResult.ok).toBe(true);
      if (!twoSidedResult.ok) return;

      const spread2 = QuoteService.getSpreadOrZero(twoSidedResult.value);
      expect(spread2.toNumber()).toBe(0.04);
    });

    it('getMidOrNull возвращает null для one-sided', () => {
      const bidResult = QuoteService.bidOnly(0.50, 100);
      expect(bidResult.ok).toBe(true);
      if (!bidResult.ok) return;

      const mid = QuoteService.getMidOrNull(bidResult.value);
      expect(mid).toBeNull();

      const twoSidedResult = QuoteService.create(0.48, 0.52, 100, 150);
      expect(twoSidedResult.ok).toBe(true);
      if (!twoSidedResult.ok) return;

      const mid2 = QuoteService.getMidOrNull(twoSidedResult.value);
      expect(mid2).not.toBeNull();
      expect(mid2!.value().toNumber()).toBe(0.50);
    });
  });

  describe('Equals contract', () => {
    it('сравнивает идентичные котировки с одинаковым timestamp', () => {
      // Создаём с одинаковым timestamp
      const ts = Date.now();
      const result1 = QuoteService.createFromDecimals(
        new Decimal(0.48),
        new Decimal(0.52),
        new Decimal(100),
        new Decimal(150),
        ts
      );
      const result2 = QuoteService.createFromDecimals(
        new Decimal(0.48),
        new Decimal(0.52),
        new Decimal(100),
        new Decimal(150),
        ts
      );

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      expect(result1.value.equals(result2.value)).toBe(true);
    });

    it('различает котировки с разными timestamp', () => {
      const ts1 = Date.now();
      const ts2 = ts1 + 1000; // +1 секунда

      const result1 = QuoteService.createFromDecimals(
        new Decimal(0.48),
        new Decimal(0.52),
        new Decimal(100),
        new Decimal(150),
        ts1
      );
      const result2 = QuoteService.createFromDecimals(
        new Decimal(0.48),
        new Decimal(0.52),
        new Decimal(100),
        new Decimal(150),
        ts2
      );

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      expect(result1.value.equals(result2.value)).toBe(false);
    });
  });
});
