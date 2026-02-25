/**
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import { OrderbookNormalizer } from '../../../src/normalizer/OrderbookNormalizer.js';
import { DEFAULT_NORMALIZATION_POLICY, PERMISSIVE_NORMALIZATION_POLICY } from '../../../src/normalizer/NormalizationPolicy.js';
import { OrderbookInvalidError, OrderbookInvalidReason } from '../../../src/errors/OrderbookInvalidError.js';
import type { RawOrderbook } from '../../../src/normalizer/types.js';

describe('OrderbookNormalizer', () => {
  describe('normalize() - успешная нормализация', () => {
    it('нормализует валидный raw orderbook', () => {
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
      };

      const result = OrderbookNormalizer.normalize(raw);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.marketId).toBe('market-123');
        expect(result.value.tokenId).toBe('token-yes');
        expect(result.value.bids.length).toBe(2);
        expect(result.value.asks.length).toBe(2);
      }
    });

    it('сортирует bids по убыванию цены', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [
          { price: 0.51, quantity: 100 },
          { price: 0.52, quantity: 200 }, // должен стать первым
        ],
        asks: [],
      };

      const result = OrderbookNormalizer.normalize(raw);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bids[0].price.value).toBe(0.52);
        expect(result.value.bids[1].price.value).toBe(0.51);
      }
    });

    it('сортирует asks по возрастанию цены', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [],
        asks: [
          { price: 0.54, quantity: 100 },
          { price: 0.53, quantity: 200 }, // должен стать первым
        ],
      };

      const result = OrderbookNormalizer.normalize(raw);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.asks[0].price.value).toBe(0.53);
        expect(result.value.asks[1].price.value).toBe(0.54);
      }
    });

    it('устанавливает receivedAt если отсутствует', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [],
        asks: [],
      };

      const before = Date.now();
      const result = OrderbookNormalizer.normalize(raw);
      const after = Date.now();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.receivedAt).toBeGreaterThanOrEqual(before);
        expect(result.value.receivedAt).toBeLessThanOrEqual(after);
      }
    });

    it('парсит venueTimestamp из ISO string', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [],
        asks: [],
        venueTimestamp: '2024-01-15T10:30:00.000Z',
      };

      const result = OrderbookNormalizer.normalize(raw);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.venueTimestamp).toBe(new Date('2024-01-15T10:30:00.000Z').getTime());
      }
    });

    it('парсит venueTimestamp из unix timestamp', () => {
      const timestamp = 1705318200000;
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [],
        asks: [],
        venueTimestamp: timestamp,
      };

      const result = OrderbookNormalizer.normalize(raw);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.venueTimestamp).toBe(timestamp);
      }
    });
  });

  describe('normalize() - фильтрация нулевых quantity', () => {
    it('фильтрует нулевые quantity если dropZeroQty=true', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [
          { price: 0.52, quantity: 0 }, // должен быть отфильтрован
          { price: 0.51, quantity: 100 },
        ],
        asks: [
          { price: 0.53, quantity: 0 }, // должен быть отфильтрован
          { price: 0.54, quantity: 150 },
        ],
      };

      const result = OrderbookNormalizer.normalize(raw, DEFAULT_NORMALIZATION_POLICY);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bids.length).toBe(1);
        expect(result.value.asks.length).toBe(1);
        expect(result.value.bids[0].price.value).toBe(0.51);
        expect(result.value.asks[0].price.value).toBe(0.54);
      }
    });

    it('оставляет нулевые quantity если dropZeroQty=false', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [
          { price: 0.52, quantity: 0 },
          { price: 0.51, quantity: 100 },
        ],
        asks: [],
      };

      const result = OrderbookNormalizer.normalize(raw, PERMISSIVE_NORMALIZATION_POLICY);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bids.length).toBe(2);
        expect(result.value.bids[0].quantity.isZero()).toBe(true);
      }
    });
  });

  describe('normalize() - агрегация дубликатов', () => {
    it('агрегирует дубликаты price если aggregateSamePrice=true', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [
          { price: 0.51, quantity: 100 },
          { price: 0.51, quantity: 50 }, // должен быть агрегирован
          { price: 0.50, quantity: 200 },
        ],
        asks: [],
      };

      const result = OrderbookNormalizer.normalize(raw, DEFAULT_NORMALIZATION_POLICY);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bids.length).toBe(2);
        // Найти уровень с price 0.51
        const level51 = result.value.bids.find(b => b.price.value === 0.51);
        expect(level51).toBeDefined();
        expect(level51!.quantity.value).toBe(150); // 100 + 50
      }
    });

    it('оставляет дубликаты если aggregateSamePrice=false', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [
          { price: 0.51, quantity: 100 },
          { price: 0.51, quantity: 50 },
        ],
        asks: [],
      };

      const result = OrderbookNormalizer.normalize(raw, PERMISSIVE_NORMALIZATION_POLICY);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bids.length).toBe(2);
      }
    });
  });

  describe('normalize() - ограничение уровней', () => {
    it('ограничивает количество уровней если maxLevelsPerSide установлен', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [
          { price: 0.52, quantity: 100 },
          { price: 0.51, quantity: 200 },
          { price: 0.50, quantity: 300 },
        ],
        asks: [
          { price: 0.53, quantity: 150 },
          { price: 0.54, quantity: 250 },
          { price: 0.55, quantity: 350 },
        ],
      };

      const policy = { ...DEFAULT_NORMALIZATION_POLICY, maxLevelsPerSide: 2 };
      const result = OrderbookNormalizer.normalize(raw, policy);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bids.length).toBe(2);
        expect(result.value.asks.length).toBe(2);
        // Проверяем что оставлены лучшие уровни
        expect(result.value.bids[0].price.value).toBe(0.52);
        expect(result.value.asks[0].price.value).toBe(0.53);
      }
    });
  });

  describe('normalize() - валидация crossed book', () => {
    it('возвращает ошибку для crossed book если allowCrossed=false', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [{ price: 0.54, quantity: 100 }], // bid > ask
        asks: [{ price: 0.53, quantity: 150 }],
      };

      const result = OrderbookNormalizer.normalize(raw, DEFAULT_NORMALIZATION_POLICY);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(OrderbookInvalidError.isOrderbookInvalidError(result.error)).toBe(true);
        expect((result.error as OrderbookInvalidError).getReason()).toBe(OrderbookInvalidReason.CROSSED_BOOK);
      }
    });

    it('допускает crossed book если allowCrossed=true', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [{ price: 0.54, quantity: 100 }],
        asks: [{ price: 0.53, quantity: 150 }],
      };

      const result = OrderbookNormalizer.normalize(raw, PERMISSIVE_NORMALIZATION_POLICY);

      expect(result.ok).toBe(true);
    });
  });

  describe('normalize() - ошибки валидации', () => {
    it('возвращает ошибку для отсутствующего marketId', () => {
      const raw: RawOrderbook = {
        marketId: undefined as unknown as string,
        tokenId: 'token-yes',
        bids: [],
        asks: [],
      };

      const result = OrderbookNormalizer.normalize(raw);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('marketId');
      }
    });

    it('возвращает ошибку для отсутствующего tokenId', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: undefined as unknown as string,
        bids: [],
        asks: [],
      };

      const result = OrderbookNormalizer.normalize(raw);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('tokenId');
      }
    });

    it('возвращает ошибку для невалидного price', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [{ price: -0.5, quantity: 100 }], // negative price
        asks: [],
      };

      const result = OrderbookNormalizer.normalize(raw);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('price');
      }
    });

    it('возвращает ошибку для невалидного quantity', () => {
      const raw: RawOrderbook = {
        marketId: 'market-123',
        tokenId: 'token-yes',
        bids: [{ price: 0.52, quantity: -100 }], // negative quantity
        asks: [],
      };

      const result = OrderbookNormalizer.normalize(raw);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('quantity');
      }
    });
  });
});
