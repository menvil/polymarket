/**
 * Unit tests for TradeExecutedEvent
 *
 * @remarks
 * Tests domain event for executed trades.
 */

import { describe, it, expect } from '@jest/globals';
import { TradeExecutedEvent } from '../../../../src/domain/events/TradeExecutedEvent.js';

describe('TradeExecutedEvent', () => {
  const TEST_ASSET_ID = 'token-12345';
  const TEST_PRICE = 0.52;
  const TEST_SIZE = 50;

  describe('constructor', () => {
    it('should create event with correct eventName', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY'
      );

      expect(event.eventName).toBe('TradeExecuted');
    });

    it('should store assetId', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY'
      );

      expect(event.assetId).toBe(TEST_ASSET_ID);
    });

    it('should store price', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY'
      );

      expect(event.price).toBe(TEST_PRICE);
    });

    it('should store size', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY'
      );

      expect(event.size).toBe(TEST_SIZE);
    });

    it('should store side as BUY', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY'
      );

      expect(event.side).toBe('BUY');
    });

    it('should store side as SELL', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'SELL'
      );

      expect(event.side).toBe('SELL');
    });

    it('should store side as null', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        null
      );

      expect(event.side).toBeNull();
    });

    it('should use provided timestamp', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY',
        now
      );

      expect(event.timestamp).toBe(now);
    });

    it('should default to current time if no timestamp provided', () => {
      const before = Date.now();
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY'
      );
      const after = Date.now();

      const eventTime = event.timestamp.getTime();
      expect(eventTime).toBeGreaterThanOrEqual(before);
      expect(eventTime).toBeLessThanOrEqual(after);
    });

    it('should generate unique eventId', () => {
      const event1 = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY'
      );
      const event2 = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY'
      );

      expect(event1.eventId).toBeDefined();
      expect(event2.eventId).toBeDefined();
      expect(event1.eventId).not.toBe(event2.eventId);
    });
  });

  describe('toJSON()', () => {
    it('should serialize to JSON with all fields (BUY)', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY',
        now
      );

      const json = event.toJSON();

      expect(json.eventName).toBe('TradeExecuted');
      expect(json.timestamp).toBe('2024-01-01T12:00:00.000Z');
      expect(json.assetId).toBe(TEST_ASSET_ID);
      expect(json.price).toBe(TEST_PRICE);
      expect(json.size).toBe(TEST_SIZE);
      expect(json.side).toBe('BUY');
    });

    it('should serialize to JSON with all fields (SELL)', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'SELL',
        now
      );

      const json = event.toJSON();

      expect(json.side).toBe('SELL');
    });

    it('should serialize to JSON with null side', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        null,
        now
      );

      const json = event.toJSON();

      expect(json.side).toBeNull();
    });

    it('should serialize eventId', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY'
      );

      const json = event.toJSON();

      expect(json.eventId).toBe(event.eventId);
      expect(typeof json.eventId).toBe('string');
    });

    it('should serialize timestamp as ISO string', () => {
      const now = new Date('2024-01-01T12:00:00.123Z');
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY',
        now
      );

      const json = event.toJSON();

      expect(json.timestamp).toBe('2024-01-01T12:00:00.123Z');
      expect(typeof json.timestamp).toBe('string');
    });
  });

  describe('getNotional()', () => {
    it('should calculate notional correctly', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.65,
        100,
        'BUY'
      );

      const notional = event.getNotional();
      expect(notional).toBe(65); // 0.65 * 100
    });

    it('should calculate notional for fractional values', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        50,
        'SELL'
      );

      const notional = event.getNotional();
      expect(notional).toBe(26); // 0.52 * 50
    });

    it('should work with null side', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.5,
        10,
        null
      );

      const notional = event.getNotional();
      expect(notional).toBe(5); // 0.5 * 10
    });
  });

  describe('isBuy()', () => {
    it('should return true for BUY side', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY'
      );

      expect(event.isBuy()).toBe(true);
    });

    it('should return false for SELL side', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'SELL'
      );

      expect(event.isBuy()).toBe(false);
    });

    it('should return false for null side', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        null
      );

      expect(event.isBuy()).toBe(false);
    });
  });

  describe('isSell()', () => {
    it('should return true for SELL side', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'SELL'
      );

      expect(event.isSell()).toBe(true);
    });

    it('should return false for BUY side', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        'BUY'
      );

      expect(event.isSell()).toBe(false);
    });

    it('should return false for null side', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        TEST_PRICE,
        TEST_SIZE,
        null
      );

      expect(event.isSell()).toBe(false);
    });
  });

  describe('toString()', () => {
    it('should return human-readable string for BUY', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        50,
        'BUY'
      );

      const str = event.toString();

      expect(str).toContain('TradeExecuted');
      expect(str).toContain('token-12');
      expect(str).toContain('BUY');
      expect(str).toContain('50');
      expect(str).toContain('0.52');
      expect(str).toContain('26.00');
    });

    it('should return human-readable string for SELL', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.65,
        100,
        'SELL'
      );

      const str = event.toString();

      expect(str).toContain('SELL');
      expect(str).toContain('100');
      expect(str).toContain('0.65');
      expect(str).toContain('65.00');
    });

    it('should show UNKNOWN for null side', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.5,
        10,
        null
      );

      const str = event.toString();

      expect(str).toContain('UNKNOWN');
      expect(str).toContain('10');
      expect(str).toContain('0.5');
    });
  });

  describe('edge cases', () => {
    it('should handle zero price', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0,
        100,
        'BUY'
      );

      expect(event.price).toBe(0);
      expect(event.getNotional()).toBe(0);
    });

    it('should handle zero size', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.5,
        0,
        'BUY'
      );

      expect(event.size).toBe(0);
      expect(event.getNotional()).toBe(0);
    });

    it('should handle very small values', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.0001,
        0.0001,
        'BUY'
      );

      expect(event.price).toBe(0.0001);
      expect(event.size).toBe(0.0001);
      expect(event.getNotional()).toBeCloseTo(0.00000001, 10);
    });

    it('should handle very large values', () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        1000000,
        1000000,
        'BUY'
      );

      expect(event.price).toBe(1000000);
      expect(event.size).toBe(1000000);
      expect(event.getNotional()).toBe(1000000000000);
    });
  });
});
