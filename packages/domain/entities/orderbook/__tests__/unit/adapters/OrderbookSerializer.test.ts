/**
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import { OrderbookSerializer } from '../../../src/adapters/OrderbookSerializer.js';
import { Orderbook } from '../../../src/core/Orderbook.js';
import { OrderbookNormalizer } from '../../../src/normalizer/OrderbookNormalizer.js';
import type { RawOrderbook } from '../../../src/normalizer/types.js';
import { KnownVenues } from '@polymarket/ids';

describe('OrderbookSerializer', () => {
  const createTestOrderbook = () => {
    const raw: RawOrderbook = {
      marketId: 'market-123',
      tokenId: 'token-yes',
      bids: [
        { price: 0.52, quantity: 100 },
        { price: 0.51, quantity: 200 },
      ],
      asks: [
        { price: 0.53, quantity: 150 },
        { price: 0.54, quantity: 250 },
      ],
      receivedAt: 1705318200000,
      venueTimestamp: 1705318199000,
    };

    const normalized = OrderbookNormalizer.normalize(raw);
    if (!normalized.ok) throw new Error('Failed to normalize');
    return Orderbook.fromNormalized(normalized.value, KnownVenues.POLYMARKET);
  };

  describe('fromJSON()', () => {
    it('deserializes валидный JSON', () => {
      const json = {
        venueId: 'POLYMARKET',
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [
          { price: 0.52, quantity: 100 },
          { price: 0.51, quantity: 200 },
        ],
        asks: [
          { price: 0.53, quantity: 150 },
        ],
        receivedAt: 1705318200000,
      };

      const result = OrderbookSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.marketId).toBe('market-123');
        expect(result.value.instrumentId).toBe('token-yes');
        expect(result.value.bids.length).toBe(2);
        expect(result.value.asks.length).toBe(1);
      }
    });

    it('возвращает ошибку для невалидного JSON', () => {
      const json = {
        // missing marketId
        tokenId: 'token-yes',
        bids: [],
        asks: [],
      };

      const result = OrderbookSerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message.toLowerCase()).toContain('marketid');
      }
    });

    it('fromJSON без поля bids использует пустой массив', () => {
      const json = {
        venueId: 'POLYMARKET',
        marketId: 'market-123',
        tokenId: 'token-yes',
        // bids отсутствует
        asks: [{ price: 0.53, quantity: 150 }],
      };
      const result = OrderbookSerializer.fromJSON(json);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bids.length).toBe(0);
        expect(result.value.asks.length).toBe(1);
      }
    });

    it('fromJSON без поля asks использует пустой массив', () => {
      const json = {
        venueId: 'POLYMARKET',
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [{ price: 0.51, quantity: 100 }],
        // asks отсутствует
      };
      const result = OrderbookSerializer.fromJSON(json);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bids.length).toBe(1);
        expect(result.value.asks.length).toBe(0);
      }
    });

    it('применяет normalization policy', () => {
      const json = {
        venueId: 'POLYMARKET',
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [
          { price: 0.52, quantity: 0 }, // zero qty
          { price: 0.51, quantity: 100 },
        ],
        asks: [],
      };

      const result = OrderbookSerializer.fromJSON(json); // default policy drops zero

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bids.length).toBe(1); // zero filtered out
      }
    });
  });

  describe('toJSON()', () => {
    it('serializes Orderbook to JSON', () => {
      const orderbook = createTestOrderbook();

      const json = OrderbookSerializer.toJSON(orderbook);

      expect(json.marketId).toBe('market-123');
      expect(json.tokenId).toBe('token-yes');
      expect(json.bids.length).toBe(2);
      expect(json.asks.length).toBe(2);
      expect(json.receivedAt).toBe(1705318200000);
      expect(json.venueTimestamp).toBe(1705318199000);
    });

    it('serializes levels с primitive типами', () => {
      const orderbook = createTestOrderbook();

      const json = OrderbookSerializer.toJSON(orderbook);

      expect(typeof json.bids[0].price).toBe('number');
      expect(typeof json.bids[0].quantity).toBe('number');
      expect(json.bids[0].price).toBe(0.52);
      expect(json.bids[0].quantity).toBe(100);
    });
  });

  describe('stringify()', () => {
    it('конвертирует в JSON string', () => {
      const orderbook = createTestOrderbook();

      const jsonString = OrderbookSerializer.stringify(orderbook);

      expect(typeof jsonString).toBe('string');
      const parsed = JSON.parse(jsonString);
      expect(parsed.marketId).toBe('market-123');
    });

    it('форматирует с pretty=true', () => {
      const orderbook = createTestOrderbook();

      const jsonString = OrderbookSerializer.stringify(orderbook, true);

      expect(jsonString).toContain('\n'); // formatted with newlines
      expect(jsonString).toContain('  '); // indentation
    });
  });

  describe('parse()', () => {
    it('парсит JSON string', () => {
      const jsonString = JSON.stringify({
        venueId: 'POLYMARKET',
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [{ price: 0.52, quantity: 100 }],
        asks: [{ price: 0.53, quantity: 150 }],
      });

      const result = OrderbookSerializer.parse(jsonString);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.marketId).toBe('market-123');
      }
    });

    it('возвращает ошибку для невалидного JSON', () => {
      const jsonString = '{invalid json}';

      const result = OrderbookSerializer.parse(jsonString);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message.toLowerCase()).toContain('failed to parse json');
      }
    });
  });

  describe('round-trip serialization', () => {
    it('сохраняет данные после serialize -> deserialize', () => {
      const orderbook = createTestOrderbook();

      const json = OrderbookSerializer.toJSON(orderbook);
      const result = OrderbookSerializer.fromJSON(json as unknown as Record<string, unknown>);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const restored = result.value;
        expect(restored.venueId).toBe(orderbook.venueId);
        expect(restored.marketId).toBe(orderbook.marketId);
        expect(restored.instrumentId).toBe(orderbook.instrumentId);
        expect(restored.bids.length).toBe(orderbook.bids.length);
        expect(restored.asks.length).toBe(orderbook.asks.length);
        expect(restored.receivedAt.toNumber()).toBe(orderbook.receivedAt.toNumber());
        expect(restored.venueTimestamp?.toNumber()).toBe(orderbook.venueTimestamp?.toNumber());

        // Проверка уровней
        expect(restored.getBestBid()!.value().toNumber()).toBe(orderbook.getBestBid()!.value().toNumber());
        expect(restored.getBestAsk()!.value().toNumber()).toBe(orderbook.getBestAsk()!.value().toNumber());
      }
    });

    it('сохраняет данные после stringify -> parse', () => {
      const orderbook = createTestOrderbook();

      const jsonString = OrderbookSerializer.stringify(orderbook);
      const result = OrderbookSerializer.parse(jsonString);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const restored = result.value;
        expect(restored.marketId).toBe(orderbook.marketId);
        expect(restored.bids.length).toBe(orderbook.bids.length);
      }
    });
  });
});
