import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { QuoteSerializer } from '../../../src/quote/adapters/QuoteSerializer.js';
import { Quote } from '../../../src/quote/core/index.js';
import { Price } from '../../../src/price/core/Price.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { QuoteErrorReason } from '../../../src/quote/errors/QuoteErrorReason.js';

describe('QuoteSerializer', () => {
  describe('toJSON()', () => {
    it('сериализует двустороннюю котировку в JSON', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(1234567890000)
      );

      const json = QuoteSerializer.toJSON(quote);

      expect(json.bid).toBe(0.48);
      expect(json.ask).toBe(0.52);
      expect(json.bidSize).toBe(100);
      expect(json.askSize).toBe(150);
      expect(json.timestamp).toBe(1234567890000);
    });

    it('сериализует bid-only котировку', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(0)),
        new Decimal(1234567890000)
      );

      const json = QuoteSerializer.toJSON(quote);

      expect(json.bid).toBe(0.50);
      expect(json.ask).toBeNull();
      expect(json.bidSize).toBe(100);
      expect(json.askSize).toBe(0);
    });

    it('сериализует ask-only котировку', () => {
      const quote = Quote.of(
        null,
        Price.of(new Decimal(0.51)),
        Quantity.of(new Decimal(0)),
        Quantity.of(new Decimal(200)),
        new Decimal(1234567890000)
      );

      const json = QuoteSerializer.toJSON(quote);

      expect(json.bid).toBeNull();
      expect(json.ask).toBe(0.51);
      expect(json.bidSize).toBe(0);
      expect(json.askSize).toBe(200);
    });
  });

  describe('fromJSON()', () => {
    it('десериализует валидный JSON в Quote', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const quote = result.value;
        expect(quote.bid()?.value().toNumber()).toBe(0.48);
        expect(quote.ask()?.value().toNumber()).toBe(0.52);
        expect(quote.bidSize().value().toNumber()).toBe(100);
        expect(quote.askSize().value().toNumber()).toBe(150);
        expect(quote.timestampMs().toNumber()).toBe(1234567890000);
      }
    });

    it('десериализует bid-only JSON', () => {
      const json = {
        bid: 0.50,
        ask: null,
        bidSize: 100,
        askSize: 0,
        timestamp: 1234567890000
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasBid()).toBe(true);
        expect(result.value.hasAsk()).toBe(false);
      }
    });

    it('десериализует ask-only JSON', () => {
      const json = {
        bid: null,
        ask: 0.51,
        bidSize: 0,
        askSize: 200,
        timestamp: 1234567890000
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasBid()).toBe(false);
        expect(result.value.hasAsk()).toBe(true);
      }
    });

    it('фэйлится с invalid bid field', () => {
      const json = {
        bid: 'invalid' as any,
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.context?.raw).toEqual({ field: 'bid', value: 'invalid' });
      }
    });

    it('фэйлится с invalid ask field', () => {
      const json = {
        bid: 0.48,
        ask: 'invalid' as any,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.context?.raw).toEqual({ field: 'ask', value: 'invalid' });
      }
    });

    it('фэйлится с invalid bidSize field', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 'invalid' as any,
        askSize: 150,
        timestamp: 1234567890000
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.context?.raw).toEqual({ field: 'bidSize', value: 'invalid' });
      }
    });

    it('фэйлится с invalid askSize field', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        askSize: 'invalid' as any,
        timestamp: 1234567890000
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.context?.raw).toEqual({ field: 'askSize', value: 'invalid' });
      }
    });

    it('фэйлится с invalid timestamp field', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        timestamp: 'invalid' as any
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.context?.raw).toEqual({ field: 'timestamp', value: 'invalid' });
      }
    });

    it('фэйлится когда bid > ask', () => {
      const json = {
        bid: 0.60,
        ask: 0.40,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.BID_GREATER_THAN_ASK);
      }
    });

    it('фэйлится когда обе стороны null', () => {
      const json = {
        bid: null,
        ask: null,
        bidSize: 0,
        askSize: 0,
        timestamp: 1234567890000
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.BOTH_SIDES_NULL);
      }
    });
  });

  describe('toString()', () => {
    it('сериализует Quote в JSON-строку', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(1234567890000)
      );

      const jsonString = QuoteSerializer.toString(quote);
      const parsed = JSON.parse(jsonString);

      expect(parsed.bid).toBe(0.48);
      expect(parsed.ask).toBe(0.52);
      expect(parsed.bidSize).toBe(100);
      expect(parsed.askSize).toBe(150);
      expect(parsed.timestamp).toBe(1234567890000);
    });

    it('правильно форматирует JSON', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(1234567890000)
      );

      const jsonString = QuoteSerializer.toString(quote);

      expect(jsonString).toContain('"bid":0.48');
      expect(jsonString).toContain('"ask":0.52');
      expect(jsonString).toContain('"bidSize":100');
      expect(jsonString).toContain('"askSize":150');
      expect(jsonString).toContain('"timestamp":1234567890000');
    });
  });

  describe('parse()', () => {
    it('парсит валидную JSON-строку в Quote', () => {
      const jsonString = '{"bid":0.48,"ask":0.52,"bidSize":100,"askSize":150,"timestamp":1234567890000}';

      const result = QuoteSerializer.parse(jsonString);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const quote = result.value;
        expect(quote.bid()?.value().toNumber()).toBe(0.48);
        expect(quote.ask()?.value().toNumber()).toBe(0.52);
        expect(quote.timestampMs().toNumber()).toBe(1234567890000);
      }
    });

    it('парсит bid-only JSON-строку', () => {
      const jsonString = '{"bid":0.50,"ask":null,"bidSize":100,"askSize":0,"timestamp":1234567890000}';

      const result = QuoteSerializer.parse(jsonString);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasBid()).toBe(true);
        expect(result.value.hasAsk()).toBe(false);
      }
    });

    it('фэйлится с invalid JSON syntax', () => {
      const jsonString = '{invalid json}';

      const result = QuoteSerializer.parse(jsonString);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('Failed to parse JSON string');
      }
    });

    it('фэйлится с invalid Quote data', () => {
      const jsonString = '{"bid":0.60,"ask":0.40,"bidSize":100,"askSize":150,"timestamp":1234567890000}';

      const result = QuoteSerializer.parse(jsonString);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.BID_GREATER_THAN_ASK);
      }
    });

    it('roundtrip: toString() -> parse() сохраняет данные', () => {
      const original = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(1234567890000)
      );

      const jsonString = QuoteSerializer.toString(original);
      const result = QuoteSerializer.parse(jsonString);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const restored = result.value;
        expect(original.equals(restored)).toBe(true);
      }
    });

    it('roundtrip: toJSON() -> fromJSON() сохраняет данные', () => {
      const original = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(1234567890000)
      );

      const json = QuoteSerializer.toJSON(original);
      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const restored = result.value;
        expect(original.equals(restored)).toBe(true);
      }
    });
  });
});
