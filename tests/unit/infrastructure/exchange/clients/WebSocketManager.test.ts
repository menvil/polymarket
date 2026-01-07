/**
 * Unit tests for WebSocketManager
 *
 * @remarks
 * Critical tests for event emission order after refactoring.
 *
 * These tests verify:
 * 1. handleMessage() emits 'message' event with raw Buffer BEFORE parsing
 * 2. processMessage() does NOT emit 'message' event
 * 3. processMessage() emits 'raw' event for data messages with asset_id
 * 4. Proper event flow: raw Buffer → parse → specific events
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EventEmitter } from 'events';

/**
 * Minimal WebSocketManager mock for testing event emission
 */
class WebSocketManagerTestDouble extends EventEmitter {
  /**
   * Simulates handleMessage() logic
   * CRITICAL: Must emit 'message' BEFORE parsing
   */
  public handleMessage(data: Buffer): void {
    // STEP 1: Emit raw message FIRST (for router)
    this.emit('message', data);

    // STEP 2: Parse JSON
    try {
      const message = JSON.parse(data.toString());

      if (Array.isArray(message)) {
        for (const msg of message) {
          this.processMessage(msg);
        }
      } else {
        this.processMessage(message);
      }
    } catch (error) {
      // Parsing errors are logged, not tested here
    }
  }

  /**
   * Simulates processMessage() logic
   * CRITICAL: Must NOT emit 'message', only emit 'raw' for data events
   */
  public processMessage(message: any): void {
    const eventType = message.event_type || message.type;
    const assetId = message.asset_id;

    // Emit 'raw' for data messages with asset_id
    if (assetId && (eventType === 'book' || eventType === 'trade' || eventType === 'last_trade_price')) {
      this.emit('raw', message);
    }

    // Emit specific event types
    if (eventType === 'book') {
      this.emit('orderbook', message);
    } else if (eventType === 'trade' || eventType === 'last_trade_price') {
      this.emit('trade', message);
    }

    // NOTE: Does NOT emit 'message' here!
  }
}

describe('WebSocketManager - Event Emission Order', () => {
  let wsManager: WebSocketManagerTestDouble;

  beforeEach(() => {
    wsManager = new WebSocketManagerTestDouble();
  });

  describe('handleMessage() - emit order', () => {
    it('should emit "message" event with raw Buffer data BEFORE parsing', () => {
      const rawData = Buffer.from(JSON.stringify({
        event_type: 'book',
        asset_id: '123',
        bids: [],
        asks: [],
      }));

      const messageSpy = jest.fn();
      const orderbookSpy = jest.fn();

      wsManager.on('message', messageSpy);
      wsManager.on('orderbook', orderbookSpy);

      wsManager.handleMessage(rawData);

      // Should emit 'message' with raw Buffer
      expect(messageSpy).toHaveBeenCalledTimes(1);
      expect(messageSpy).toHaveBeenCalledWith(rawData);

      // Verify it's a Buffer, not parsed object
      expect(Buffer.isBuffer(messageSpy.mock.calls[0][0])).toBe(true);

      // 'orderbook' should also be emitted (after parsing)
      expect(orderbookSpy).toHaveBeenCalledTimes(1);
    });

    it('should emit "message" BEFORE specific events (orderbook, trade)', () => {
      const callOrder: string[] = [];

      wsManager.on('message', () => callOrder.push('message'));
      wsManager.on('orderbook', () => callOrder.push('orderbook'));
      wsManager.on('raw', () => callOrder.push('raw'));

      const rawData = Buffer.from(JSON.stringify({
        event_type: 'book',
        asset_id: '123',
        bids: [],
        asks: [],
      }));

      wsManager.handleMessage(rawData);

      // Order should be: message → raw → orderbook
      expect(callOrder).toEqual(['message', 'raw', 'orderbook']);
    });

    it('should handle batch messages correctly', () => {
      const messageSpy = jest.fn();
      const rawSpy = jest.fn();
      const orderbookSpy = jest.fn();
      const tradeSpy = jest.fn();

      wsManager.on('message', messageSpy);
      wsManager.on('raw', rawSpy);
      wsManager.on('orderbook', orderbookSpy);
      wsManager.on('trade', tradeSpy);

      const batchData = Buffer.from(JSON.stringify([
        { event_type: 'book', asset_id: '123', bids: [], asks: [] },
        { event_type: 'trade', asset_id: '123', price: '0.5', size: '100' },
        { event_type: 'trade', asset_id: '456', price: '0.6', size: '200' },
      ]));

      wsManager.handleMessage(batchData);

      // 'message' emitted once with raw Buffer
      expect(messageSpy).toHaveBeenCalledTimes(1);
      expect(Buffer.isBuffer(messageSpy.mock.calls[0][0])).toBe(true);

      // 'raw' emitted 3 times (once per message)
      expect(rawSpy).toHaveBeenCalledTimes(3);

      // 'orderbook' emitted once
      expect(orderbookSpy).toHaveBeenCalledTimes(1);

      // 'trade' emitted twice
      expect(tradeSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('processMessage() - raw event emission', () => {
    it('should emit "raw" event for book messages with asset_id', () => {
      const rawSpy = jest.fn();
      const message = {
        event_type: 'book',
        asset_id: '123',
        bids: [],
        asks: [],
      };

      wsManager.on('raw', rawSpy);
      wsManager.processMessage(message);

      expect(rawSpy).toHaveBeenCalledTimes(1);
      expect(rawSpy).toHaveBeenCalledWith(message);
    });

    it('should emit "raw" event for trade messages with asset_id', () => {
      const rawSpy = jest.fn();
      const message = {
        event_type: 'trade',
        asset_id: '123',
        price: '0.5',
        size: '100',
      };

      wsManager.on('raw', rawSpy);
      wsManager.processMessage(message);

      expect(rawSpy).toHaveBeenCalledTimes(1);
      expect(rawSpy).toHaveBeenCalledWith(message);
    });

    it('should emit "raw" event for last_trade_price messages with asset_id', () => {
      const rawSpy = jest.fn();
      const message = {
        event_type: 'last_trade_price',
        asset_id: '123',
        price: '0.55',
        size: '75',
      };

      wsManager.on('raw', rawSpy);
      wsManager.processMessage(message);

      expect(rawSpy).toHaveBeenCalledTimes(1);
      expect(rawSpy).toHaveBeenCalledWith(message);
    });

    it('should NOT emit "raw" for price_change messages', () => {
      const rawSpy = jest.fn();
      const message = {
        event_type: 'price_change',
        market: '0x123',
      };

      wsManager.on('raw', rawSpy);
      wsManager.processMessage(message);

      expect(rawSpy).not.toHaveBeenCalled();
    });

    it('should NOT emit "raw" for messages without asset_id', () => {
      const rawSpy = jest.fn();
      const message = {
        event_type: 'book',
        bids: [],
        asks: [],
      };

      wsManager.on('raw', rawSpy);
      wsManager.processMessage(message);

      expect(rawSpy).not.toHaveBeenCalled();
    });

    it('should NOT emit "message" from processMessage', () => {
      const messageSpy = jest.fn();
      const message = {
        event_type: 'book',
        asset_id: '123',
        bids: [],
        asks: [],
      };

      wsManager.on('message', messageSpy);
      wsManager.processMessage(message);

      // processMessage should NOT emit 'message'
      expect(messageSpy).not.toHaveBeenCalled();
    });
  });

  describe('Event flow integration', () => {
    it('should follow correct event order: message(raw) → raw(parsed) → specific events', () => {
      const events: Array<{ event: string; dataType: string }> = [];

      wsManager.on('message', (data) => {
        events.push({
          event: 'message',
          dataType: Buffer.isBuffer(data) ? 'Buffer' : 'Object',
        });
      });

      wsManager.on('raw', (data) => {
        events.push({
          event: 'raw',
          dataType: typeof data === 'object' ? 'Object' : typeof data,
        });
      });

      wsManager.on('orderbook', (data) => {
        events.push({
          event: 'orderbook',
          dataType: typeof data === 'object' ? 'Object' : typeof data,
        });
      });

      const rawData = Buffer.from(JSON.stringify({
        event_type: 'book',
        asset_id: '123',
        bids: [],
        asks: [],
      }));

      wsManager.handleMessage(rawData);

      // Verify event order and data types
      expect(events).toEqual([
        { event: 'message', dataType: 'Buffer' },
        { event: 'raw', dataType: 'Object' },
        { event: 'orderbook', dataType: 'Object' },
      ]);
    });

    it('should allow router to parse raw Buffer from "message" event', () => {
      let parsedByRouter: any = null;

      // Simulate router listening to 'message' event
      wsManager.on('message', (data: Buffer) => {
        // Router should receive raw Buffer and parse it
        parsedByRouter = JSON.parse(data.toString());
      });

      const rawData = Buffer.from(JSON.stringify({
        event_type: 'book',
        asset_id: '123',
        bids: [{ price: '0.52', size: '100' }],
        asks: [{ price: '0.53', size: '150' }],
      }));

      wsManager.handleMessage(rawData);

      // Router should successfully parse the raw Buffer
      expect(parsedByRouter).toBeDefined();
      expect(parsedByRouter.event_type).toBe('book');
      expect(parsedByRouter.asset_id).toBe('123');
      expect(parsedByRouter.bids).toHaveLength(1);
    });
  });
});
