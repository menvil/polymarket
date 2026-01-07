/**
 * Unit tests for OrderBookSnapshotReceivedEvent
 *
 * @remarks
 * Tests domain event for orderbook snapshots.
 */

import { describe, it, expect } from '@jest/globals';
import { OrderBookSnapshotReceivedEvent } from '../../../../src/domain/events/OrderBookSnapshotReceivedEvent.js';

describe('OrderBookSnapshotReceivedEvent', () => {
  const TEST_ASSET_ID = 'token-12345';
  const TEST_BIDS = [
    { price: 0.52, size: 100 },
    { price: 0.51, size: 200 },
  ];
  const TEST_ASKS = [
    { price: 0.53, size: 150 },
    { price: 0.54, size: 250 },
  ];

  describe('constructor', () => {
    it('should create event with correct eventName', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );

      expect(event.eventName).toBe('OrderBookSnapshotReceived');
    });

    it('should store assetId', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );

      expect(event.assetId).toBe(TEST_ASSET_ID);
    });

    it('should store bids', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );

      expect(event.bids).toEqual(TEST_BIDS);
      expect(event.bids.length).toBe(2);
      expect(event.bids[0].price).toBe(0.52);
      expect(event.bids[0].size).toBe(100);
    });

    it('should store asks', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );

      expect(event.asks).toEqual(TEST_ASKS);
      expect(event.asks.length).toBe(2);
      expect(event.asks[0].price).toBe(0.53);
      expect(event.asks[0].size).toBe(150);
    });

    it('should use provided timestamp', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS,
        now
      );

      expect(event.timestamp).toBe(now);
    });

    it('should default to current time if no timestamp provided', () => {
      const before = Date.now();
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );
      const after = Date.now();

      const eventTime = event.timestamp.getTime();
      expect(eventTime).toBeGreaterThanOrEqual(before);
      expect(eventTime).toBeLessThanOrEqual(after);
    });

    it('should generate unique eventId', () => {
      const event1 = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );
      const event2 = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );

      expect(event1.eventId).toBeDefined();
      expect(event2.eventId).toBeDefined();
      expect(event1.eventId).not.toBe(event2.eventId);
    });

    it('should accept empty bids array', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        TEST_ASKS
      );

      expect(event.bids).toEqual([]);
      expect(event.bids.length).toBe(0);
    });

    it('should accept empty asks array', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        []
      );

      expect(event.asks).toEqual([]);
      expect(event.asks.length).toBe(0);
    });

    it('should accept both empty arrays (no liquidity)', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        []
      );

      expect(event.bids.length).toBe(0);
      expect(event.asks.length).toBe(0);
    });
  });

  describe('toJSON()', () => {
    it('should serialize to JSON with all fields', () => {
      const now = new Date('2024-01-01T12:00:00Z');
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS,
        now
      );

      const json = event.toJSON();

      expect(json.eventName).toBe('OrderBookSnapshotReceived');
      expect(json.timestamp).toBe('2024-01-01T12:00:00.000Z');
      expect(json.assetId).toBe(TEST_ASSET_ID);
      expect(json.bids).toEqual(TEST_BIDS);
      expect(json.asks).toEqual(TEST_ASKS);
    });

    it('should serialize eventId', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );

      const json = event.toJSON();

      expect(json.eventId).toBe(event.eventId);
      expect(typeof json.eventId).toBe('string');
    });

    it('should serialize timestamp as ISO string', () => {
      const now = new Date('2024-01-01T12:00:00.123Z');
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS,
        now
      );

      const json = event.toJSON();

      expect(json.timestamp).toBe('2024-01-01T12:00:00.123Z');
      expect(typeof json.timestamp).toBe('string');
    });

    it('should serialize empty arrays correctly', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        []
      );

      const json = event.toJSON();

      expect(json.bids).toEqual([]);
      expect(json.asks).toEqual([]);
    });
  });

  describe('getBestBid()', () => {
    it('should return first bid price', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );

      expect(event.getBestBid()).toBe(0.52);
    });

    it('should return null if no bids', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        TEST_ASKS
      );

      expect(event.getBestBid()).toBeNull();
    });
  });

  describe('getBestAsk()', () => {
    it('should return first ask price', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );

      expect(event.getBestAsk()).toBe(0.53);
    });

    it('should return null if no asks', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        []
      );

      expect(event.getBestAsk()).toBeNull();
    });
  });

  describe('getSpread()', () => {
    it('should calculate spread correctly', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );

      const spread = event.getSpread();
      expect(spread).toBeCloseTo(0.01, 5); // 0.53 - 0.52
    });

    it('should return null if no bids', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        TEST_ASKS
      );

      expect(event.getSpread()).toBeNull();
    });

    it('should return null if no asks', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        []
      );

      expect(event.getSpread()).toBeNull();
    });

    it('should return null if both empty', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        []
      );

      expect(event.getSpread()).toBeNull();
    });
  });

  describe('toString()', () => {
    it('should return human-readable string', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        TEST_ASKS
      );

      const str = event.toString();

      expect(str).toContain('OrderBookSnapshotReceived');
      expect(str).toContain('token-12');
      expect(str).toContain('2 bids');
      expect(str).toContain('2 asks');
      expect(str).toContain('0.0100');
    });

    it('should show N/A for spread when no liquidity', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        []
      );

      const str = event.toString();

      expect(str).toContain('0 bids');
      expect(str).toContain('0 asks');
      expect(str).toContain('N/A');
    });
  });

  describe('immutability', () => {
    it('should preserve bids array reference', () => {
      const bids = [{ price: 0.52, size: 100 }];
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        bids,
        TEST_ASKS
      );

      // Event stores readonly reference to same array
      expect(event.bids).toEqual(bids);
      expect(event.bids.length).toBe(1);
    });

    it('should preserve asks array reference', () => {
      const asks = [{ price: 0.53, size: 150 }];
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        TEST_BIDS,
        asks
      );

      // Event stores readonly reference to same array
      expect(event.asks).toEqual(asks);
      expect(event.asks.length).toBe(1);
    });
  });
});
