import Decimal from 'decimal.js';
import type { MarketDataSourceId, InstrumentId } from '@polymarket/ids';
import { describe, it, expect } from '@jest/globals';
import { QuoteSerializer } from '../../../src/quote/adapters/QuoteSerializer.js';
import { Quote } from '../../../src/quote/core/index.js';
import { Price } from '../../../src/price/core/Price.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { QuoteErrorReason } from '../../../src/quote/errors/QuoteErrorReason.js';

// Тестовые константы для sourceId и instrumentId
const TEST_SOURCE_ID = 'TEST_SOURCE' as MarketDataSourceId;
const TEST_INSTRUMENT_ID = 'TEST_INSTRUMENT' as InstrumentId;

describe('QuoteSerializer', () => {
  describe('toJSON()', () => {
    it('сериализует двустороннюю котировку в JSON', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(1234567890000)
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const json = QuoteSerializer.toJSON(quote);

      expect(json.bid).toBe(0.48);
      expect(json.ask).toBe(0.52);
      expect(json.bidSize).toBe(100);
      expect(json.askSize).toBe(150);
      expect(json.timestamp).toBe(1234567890000);
      expect(json.sourceId).toBe(TEST_SOURCE_ID);
      expect(json.instrumentId).toBe(TEST_INSTRUMENT_ID);
    });

    it('сериализует bid-only котировку', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.50)),
        null,
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(0)),
        new Decimal(1234567890000)
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

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
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

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
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
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
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
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
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasBid()).toBe(false);
        expect(result.value.hasAsk()).toBe(true);
      }
    });

    it('фэйлится когда json is null', () => {
      const result = QuoteSerializer.fromJSON(null);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('Expected object');
      }
    });

    it('фэйлится когда json is array', () => {
      const result = QuoteSerializer.fromJSON([0.48, 0.52]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('Expected object');
      }
    });

    it('фэйлится когда отсутствует поле bid', () => {
      const json = {
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('Missing required field: bid');
      }
    });

    it('фэйлится когда отсутствует поле ask', () => {
      const json = {
        bid: 0.48,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('Missing required field: ask');
      }
    });

    it('фэйлится когда отсутствует поле bidSize', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        askSize: 150,
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('Missing required field: bidSize');
      }
    });

    it('фэйлится когда отсутствует поле askSize', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('Missing required field: askSize');
      }
    });

    it('фэйлится когда отсутствует поле timestamp', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('Missing required field: timestamp');
      }
    });

    it('фэйлится с invalid bid field type', () => {
      const json = {
        bid: 'invalid' as any,
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        const raw = result.error.context?.raw as any;
        expect(raw?.field).toBe('bid');
        expect(raw?.type).toBe('string');
      }
    });

    it('фэйлится с invalid ask field type', () => {
      const json = {
        bid: 0.48,
        ask: 'invalid' as any,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        const raw = result.error.context?.raw as any;
        expect(raw?.field).toBe('ask');
        expect(raw?.type).toBe('string');
      }
    });

    it('фэйлится с invalid bidSize field type', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 'invalid' as any,
        askSize: 150,
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        const raw = result.error.context?.raw as any;
        expect(raw?.field).toBe('bidSize');
        expect(raw?.type).toBe('string');
      }
    });

    it('фэйлится с invalid askSize field type', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        askSize: 'invalid' as any,
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        const raw = result.error.context?.raw as any;
        expect(raw?.field).toBe('askSize');
        expect(raw?.type).toBe('string');
      }
    });

    it('фэйлится с invalid timestamp field type', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        timestamp: 'invalid' as any,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        const raw = result.error.context?.raw as any;
        expect(raw?.field).toBe('timestamp');
        expect(raw?.type).toBe('string');
      }
    });

    it('фэйлится когда bid > ask', () => {
      const json = {
        bid: 0.60,
        ask: 0.40,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
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
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.BOTH_SIDES_NULL);
      }
    });

    // Тесты для sourceId/instrumentId missing/invalid
    it('возвращает Err для missing sourceId', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000,
        // sourceId missing
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('sourceId');
      }
    });

    it('возвращает Err для invalid type sourceId', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000,
        sourceId: 123, // number instead of string
        instrumentId: 'TEST_INSTRUMENT'
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('sourceId');
      }
    });

    it('возвращает Err для missing instrumentId', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE'
        // instrumentId missing
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('instrumentId');
      }
    });

    it('возвращает Err для invalid type instrumentId', () => {
      const json = {
        bid: 0.48,
        ask: 0.52,
        bidSize: 100,
        askSize: 150,
        timestamp: 1234567890000,
        sourceId: 'TEST_SOURCE',
        instrumentId: null // null instead of string
      };

      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('instrumentId');
      }
    });

    // Тесты для safeStringify (circular references, unstringifiable)
    it('обрабатывает circular references через safeStringify', () => {
      const circular: any = { bid: 0.48 };
      circular.self = circular;

      const result = QuoteSerializer.fromJSON(circular);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // safeStringify обрабатывает circular reference (проверяем что код не крешится)
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
      }
    });

    it('обрабатывает unstringifiable values через catch-ветку safeStringify', () => {
      const unstringifiable = {
        bid: 0.48,
        get badProperty() {
          throw new Error('Cannot serialize this property');
        }
      };

      const result = QuoteSerializer.fromJSON(unstringifiable);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // safeStringify catch-ветка обрабатывает unstringifiable (проверяем что код не крешится)
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
      }
    });
  });

  describe('toJSONString()', () => {
    it('сериализует Quote в JSON-строку', () => {
      const quote = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(1234567890000)
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const jsonString = QuoteSerializer.toJSONString(quote);
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
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const jsonString = QuoteSerializer.toJSONString(quote);

      expect(jsonString).toContain('"bid":0.48');
      expect(jsonString).toContain('"ask":0.52');
      expect(jsonString).toContain('"bidSize":100');
      expect(jsonString).toContain('"askSize":150');
      expect(jsonString).toContain('"timestamp":1234567890000');
      expect(jsonString).toContain('"sourceId":"TEST_SOURCE"');
      expect(jsonString).toContain('"instrumentId":"TEST_INSTRUMENT"');
    });
  });

  describe('fromJSONString()', () => {
    it('парсит валидную JSON-строку в Quote', () => {
      const jsonString = '{"bid":0.48,"ask":0.52,"bidSize":100,"askSize":150,"timestamp":1234567890000,"sourceId":"TEST_SOURCE","instrumentId":"TEST_INSTRUMENT"}';

      const result = QuoteSerializer.fromJSONString(jsonString);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const quote = result.value;
        expect(quote.bid()?.value().toNumber()).toBe(0.48);
        expect(quote.ask()?.value().toNumber()).toBe(0.52);
        expect(quote.timestampMs().toNumber()).toBe(1234567890000);
      }
    });

    it('парсит bid-only JSON-строку', () => {
      const jsonString = '{"bid":0.50,"ask":null,"bidSize":100,"askSize":0,"timestamp":1234567890000,"sourceId":"TEST_SOURCE","instrumentId":"TEST_INSTRUMENT"}';

      const result = QuoteSerializer.fromJSONString(jsonString);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasBid()).toBe(true);
        expect(result.value.hasAsk()).toBe(false);
      }
    });

    it('фэйлится с invalid JSON syntax', () => {
      const jsonString = '{invalid json}';

      const result = QuoteSerializer.fromJSONString(jsonString);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('Invalid JSON string');
      }
    });

    it('фэйлится с invalid Quote data', () => {
      const jsonString = '{"bid":0.60,"ask":0.40,"bidSize":100,"askSize":150,"timestamp":1234567890000,"sourceId":"TEST_SOURCE","instrumentId":"TEST_INSTRUMENT"}';

      const result = QuoteSerializer.fromJSONString(jsonString);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(QuoteErrorReason.BID_GREATER_THAN_ASK);
      }
    });

    it('roundtrip: toJSONString() -> fromJSONString() сохраняет данные', () => {
      const original = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(1234567890000)
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const jsonString = QuoteSerializer.toJSONString(original);
      const result = QuoteSerializer.fromJSONString(jsonString);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const restored = result.value;
        expect(original.equals(restored)).toBe(true);
        expect(restored.sourceId()).toBe(TEST_SOURCE_ID);
        expect(restored.instrumentId()).toBe(TEST_INSTRUMENT_ID);
      }
    });
  });

  describe('roundtrip', () => {
    it('toJSON() -> fromJSON() сохраняет данные', () => {
      const original = Quote.of(
        Price.of(new Decimal(0.48)),
        Price.of(new Decimal(0.52)),
        Quantity.of(new Decimal(100)),
        Quantity.of(new Decimal(150)),
        new Decimal(1234567890000)
      , TEST_SOURCE_ID, TEST_INSTRUMENT_ID);

      const json = QuoteSerializer.toJSON(original);
      const result = QuoteSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const restored = result.value;
        expect(original.equals(restored)).toBe(true);
        expect(restored.sourceId()).toBe(original.sourceId());
        expect(restored.instrumentId()).toBe(original.instrumentId());
      }
    });
  });
});
