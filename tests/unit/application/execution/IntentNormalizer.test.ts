/**
 * Unit tests for IntentNormalizer
 *
 * @remarks
 * Tests pure function normalization logic (banker's rounding, tick alignment).
 * IntentNormalizer - чистая функция БЕЗ IO, полностью детерминированная.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { IntentNormalizer } from '../../../../src/application/execution/IntentNormalizer.js';
import { Order } from '../../../../src/domain/entities/Order.js';
import { Price } from '../../../../src/domain/value-objects/Price.js';
import { Quantity } from '../../../../src/domain/value-objects/Quantity.js';
import type { MarketConstraints } from '../../../../src/domain/types/ValidationContext.js';

describe('IntentNormalizer', () => {
  let normalizer: IntentNormalizer;

  beforeEach(() => {
    normalizer = new IntentNormalizer();
  });

  describe('normalize() - size rounding', () => {
    it('should round size to sizeTick (banker\'s rounding)', () => {
      const order = Order.create({
        id: 'test-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100.567), // Should round to 100.57
        status: 'PENDING',
        timestamp: new Date(),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      expect(result.wasNormalized).toBe(true);
      expect(result.order.size.value).toBe(100.57);
      expect(result.diff).toEqual({
        originalSize: 100.567,
        normalizedSize: 100.57,
        originalPrice: 0.5,
        normalizedPrice: 0.5,
      });
    });

    it('should round size using Math.round (banker\'s rounding)', () => {
      const order = Order.create({
        id: 'test-2',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100.006), // 100.006 / 0.01 = 10000.6 → round to 10001 → 100.01
        status: 'PENDING',
        timestamp: new Date(),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      expect(result.wasNormalized).toBe(true);
      expect(result.order.size.value).toBe(100.01);
    });

    it('should not normalize if already aligned to sizeTick', () => {
      const order = Order.create({
        id: 'test-3',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(100.0), // Already aligned to 0.01
        status: 'PENDING',
        timestamp: new Date(),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      expect(result.wasNormalized).toBe(false);
      expect(result.order).toBe(order); // Same instance (no new Order created)
      expect(result.diff).toBeUndefined();
    });

    it('should handle larger sizeTick (0.1)', () => {
      const order = Order.create({
        id: 'test-4',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5),
        size: Quantity.fromNumber(99.87), // Should round to 99.9 (0.1 tick)
        status: 'PENDING',
        timestamp: new Date(),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.1,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      expect(result.wasNormalized).toBe(true);
      expect(result.order.size.value).toBe(99.9);
    });
  });

  describe('normalize() - price rounding', () => {
    it('should round price to priceTick', () => {
      const order = Order.create({
        id: 'test-5',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.523), // Should round to 0.52
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      expect(result.wasNormalized).toBe(true);
      expect(result.order.price.value).toBe(0.52);
      expect(result.diff).toEqual({
        originalSize: 100,
        normalizedSize: 100,
        originalPrice: 0.523,
        normalizedPrice: 0.52,
      });
    });

    it('should handle smaller priceTick (0.001)', () => {
      const order = Order.create({
        id: 'test-6',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.5234), // Should round to 0.523 (0.001 tick)
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.001,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      expect(result.wasNormalized).toBe(true);
      expect(result.order.price.value).toBe(0.523);
    });
  });

  describe('normalize() - both size and price', () => {
    it('should normalize both size and price if needed', () => {
      const order = Order.create({
        id: 'test-7',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.567), // Round to 0.57
        size: Quantity.fromNumber(100.123), // Round to 100.12
        status: 'PENDING',
        timestamp: new Date(),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      expect(result.wasNormalized).toBe(true);
      expect(result.order.size.value).toBe(100.12);
      expect(result.order.price.value).toBe(0.57);
      expect(result.diff).toEqual({
        originalSize: 100.123,
        normalizedSize: 100.12,
        originalPrice: 0.567,
        normalizedPrice: 0.57,
      });
    });
  });

  describe('normalize() - preserves other order fields', () => {
    it('should preserve all other order fields', () => {
      const originalTimestamp = new Date('2024-01-01T00:00:00Z');
      const order = Order.create({
        id: 'test-8',
        tokenId: 'token-yes-123',
        side: 'SELL',
        price: Price.fromNumber(0.567),
        size: Quantity.fromNumber(100.123),
        status: 'PENDING',
        timestamp: originalTimestamp,
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      expect(result.order.id).toBe('test-8');
      expect(result.order.tokenId).toBe('token-yes-123');
      expect(result.order.side).toBe('SELL');
      expect(result.order.status).toBe('PENDING');
      expect(result.order.timestamp).toEqual(originalTimestamp);
    });

    it('should preserve filledSize and averageFillPrice if present', () => {
      const order = Order.create({
        id: 'test-9',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.567),
        size: Quantity.fromNumber(100.123),
        status: 'OPEN',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(40),
        averageFillPrice: Price.fromNumber(0.55),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      expect(result.order.filledSize?.value).toBe(40);
      expect(result.order.averageFillPrice?.value).toBe(0.55);
    });
  });

  describe('normalize() - edge cases', () => {
    it('should handle floating point precision issues', () => {
      const order = Order.create({
        id: 'test-10',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.1 + 0.2), // 0.30000000000000004 in JS
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      // Should normalize to clean 0.3 (not 0.30000000000000004)
      expect(result.order.price.value).toBe(0.3);
    });

    it('should handle very small values', () => {
      const order = Order.create({
        id: 'test-11',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.01234), // Round to 0.01
        size: Quantity.fromNumber(1.005), // Round to 1.00
        status: 'PENDING',
        timestamp: new Date(),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      expect(result.order.price.value).toBe(0.01);
      expect(result.order.size.value).toBe(1.0);
    });

    it('should handle very large values', () => {
      const order = Order.create({
        id: 'test-12',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.987), // Round to 0.99
        size: Quantity.fromNumber(9999.567), // Round to 9999.57
        status: 'PENDING',
        timestamp: new Date(),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      const result = normalizer.normalize(order, constraints);

      expect(result.order.price.value).toBe(0.99);
      expect(result.order.size.value).toBe(9999.57);
    });
  });

  describe('normalize() - determinism', () => {
    it('should be deterministic (same input → same output)', () => {
      const order = Order.create({
        id: 'test-13',
        tokenId: 'token-yes',
        side: 'BUY',
        price: Price.fromNumber(0.567),
        size: Quantity.fromNumber(100.123),
        status: 'PENDING',
        timestamp: new Date('2024-01-01T00:00:00Z'),
      });

      const constraints: MarketConstraints = {
        minOrderSize: 1,
        maxOrderSize: 10000,
        sizeTick: 0.01,
        priceTick: 0.01,
        minPrice: 0.01,
        maxPrice: 0.99,
      };

      // Run normalization 3 times
      const result1 = normalizer.normalize(order, constraints);
      const result2 = normalizer.normalize(order, constraints);
      const result3 = normalizer.normalize(order, constraints);

      // All results should be identical
      expect(result1.wasNormalized).toBe(result2.wasNormalized);
      expect(result1.wasNormalized).toBe(result3.wasNormalized);

      expect(result1.order.size.value).toBe(result2.order.size.value);
      expect(result1.order.size.value).toBe(result3.order.size.value);

      expect(result1.order.price.value).toBe(result2.order.price.value);
      expect(result1.order.price.value).toBe(result3.order.price.value);

      expect(result1.diff).toEqual(result2.diff);
      expect(result1.diff).toEqual(result3.diff);
    });
  });
});
