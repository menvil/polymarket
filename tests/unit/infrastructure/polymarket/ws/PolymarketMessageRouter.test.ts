/**
 * Unit tests for PolymarketMessageRouter
 *
 * @remarks
 * **Phase 2 tests - Message routing layer**
 *
 * Coverage:
 * - Constructor validation
 * - Raw data parsing (single, batch, empty, errors)
 * - Message routing (orderbook, trade, control messages)
 * - Event emission
 * - Statistics tracking
 * - Error handling
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PolymarketMessageRouter } from '../../../../../src/infrastructure/polymarket/ws/PolymarketMessageRouter.js';
import type {
  PolymarketOrderbookMessage,
  PolymarketTradeMessage,
} from '../../../../../src/infrastructure/polymarket/ws/PolymarketMessageRouter.js';
import { MockLogger } from '../../../../helpers/MockLogger.js';

describe('PolymarketMessageRouter', () => {
  let logger: MockLogger;
  let router: PolymarketMessageRouter;

  beforeEach(() => {
    logger = new MockLogger();
    router = new PolymarketMessageRouter(logger);
    // Disable max listeners warning for tests
    router.setMaxListeners(0);
  });

  describe('Constructor', () => {
    it('should create router with valid logger', () => {
      expect(router).toBeDefined();
      expect(router.getStats()).toBeDefined();
    });

    it('should throw if logger is null', () => {
      expect(() => new PolymarketMessageRouter(null as any)).toThrow('logger is required');
    });

    it('should throw if logger is undefined', () => {
      expect(() => new PolymarketMessageRouter(undefined as any)).toThrow('logger is required');
    });

    it('should initialize stats to zero', () => {
      const stats = router.getStats();
      expect(stats.totalMessages).toBe(0);
      expect(stats.orderbookMessages).toBe(0);
      expect(stats.tradeMessages).toBe(0);
      expect(stats.parsingErrors).toBe(0);
      expect(stats.batchMessages).toBe(0);
      expect(stats.skippedMessages).toBe(0);
    });
  });

  describe('processRawData()', () => {
    describe('Single messages', () => {
      it('should parse and route orderbook message', () => {
        const orderbookSpy = jest.fn();
        router.on('orderbook', orderbookSpy);

        const rawData = JSON.stringify({
          event_type: 'book',
          asset_id: '123456789',
          bids: [{ price: '0.52', size: '100' }],
          asks: [{ price: '0.53', size: '150' }],
          timestamp: 1234567890,
        });

        router.processRawData(rawData);

        expect(orderbookSpy).toHaveBeenCalledTimes(1);
        expect(orderbookSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            event_type: 'book',
            asset_id: '123456789',
          })
        );
      });

      it('should parse and route trade message', () => {
        const tradeSpy = jest.fn();
        router.on('trade', tradeSpy);

        const rawData = JSON.stringify({
          event_type: 'trade',
          asset_id: '123456789',
          price: '0.52',
          size: '50',
          side: 'BUY',
          timestamp: 1234567890,
        });

        router.processRawData(rawData);

        expect(tradeSpy).toHaveBeenCalledTimes(1);
        expect(tradeSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            event_type: 'trade',
            asset_id: '123456789',
            price: '0.52',
            size: '50',
          })
        );
      });

      it('should parse Buffer data', () => {
        const orderbookSpy = jest.fn();
        router.on('orderbook', orderbookSpy);

        const rawData = Buffer.from(JSON.stringify({
          event_type: 'book',
          asset_id: '123456789',
          bids: [],
          asks: [],
        }));

        router.processRawData(rawData);

        expect(orderbookSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe('Batch messages', () => {
      it('should parse and route array of messages', () => {
        const orderbookSpy = jest.fn();
        const tradeSpy = jest.fn();
        router.on('orderbook', orderbookSpy);
        router.on('trade', tradeSpy);

        const rawData = JSON.stringify([
          {
            event_type: 'book',
            asset_id: '123',
            bids: [],
            asks: [],
          },
          {
            event_type: 'trade',
            asset_id: '456',
            price: '0.5',
            size: '10',
          },
        ]);

        router.processRawData(rawData);

        expect(orderbookSpy).toHaveBeenCalledTimes(1);
        expect(tradeSpy).toHaveBeenCalledTimes(1);

        const stats = router.getStats();
        expect(stats.batchMessages).toBe(1);
        expect(stats.totalMessages).toBe(2);
      });

      it('should process empty batch array', () => {
        const rawData = JSON.stringify([]);

        router.processRawData(rawData);

        const stats = router.getStats();
        expect(stats.batchMessages).toBe(1);
        expect(stats.totalMessages).toBe(0);
      });

      it('should process large batch', () => {
        const orderbookSpy = jest.fn();
        router.on('orderbook', orderbookSpy);

        const batch = Array.from({ length: 100 }, (_, i) => ({
          event_type: 'book',
          asset_id: `${i}`,
          bids: [],
          asks: [],
        }));

        router.processRawData(JSON.stringify(batch));

        expect(orderbookSpy).toHaveBeenCalledTimes(100);
        const stats = router.getStats();
        expect(stats.orderbookMessages).toBe(100);
      });
    });

    describe('Empty and whitespace', () => {
      it('should skip empty string (heartbeat)', () => {
        const messageSpy = jest.fn();
        router.on('message', messageSpy);

        router.processRawData('');

        expect(messageSpy).not.toHaveBeenCalled();
        expect(logger.traceCalls.length).toBeGreaterThan(0);
      });

      it('should skip whitespace-only string', () => {
        const messageSpy = jest.fn();
        router.on('message', messageSpy);

        router.processRawData('   \n  \t  ');

        expect(messageSpy).not.toHaveBeenCalled();
      });
    });

    describe('Parsing errors', () => {
      it('should handle invalid JSON', () => {
        const errorSpy = jest.fn();
        router.on('error', errorSpy);

        router.processRawData('invalid json {{}');

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));

        const stats = router.getStats();
        expect(stats.parsingErrors).toBe(1);
      });

      it('should handle known Polymarket errors', () => {
        const errorSpy = jest.fn();
        router.on('error', errorSpy);

        router.processRawData('INVALID OPERATION');

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(logger.errorCalls.some(c => c.message.includes('Polymarket WebSocket error'))).toBe(true);

        const stats = router.getStats();
        expect(stats.parsingErrors).toBe(1);
      });

      it('should handle RATE_LIMIT error', () => {
        const errorSpy = jest.fn();
        router.on('error', errorSpy);

        router.processRawData('RATE_LIMIT exceeded');

        expect(errorSpy).toHaveBeenCalledTimes(1);
      });

      it('should handle UNAUTHORIZED error', () => {
        const errorSpy = jest.fn();
        router.on('error', errorSpy);

        router.processRawData('UNAUTHORIZED access');

        expect(errorSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('processMessage()', () => {
    describe('Orderbook routing', () => {
      it('should emit orderbook event for book message', () => {
        const orderbookSpy = jest.fn();
        const messageSpy = jest.fn();
        const rawSpy = jest.fn();

        router.on('orderbook', orderbookSpy);
        router.on('message', messageSpy);
        router.on('raw', rawSpy);

        const message: PolymarketOrderbookMessage = {
          event_type: 'book',
          asset_id: '123456789',
          bids: [{ price: '0.52', size: '100' }],
          asks: [{ price: '0.53', size: '150' }],
          timestamp: 1234567890,
        };

        router.processMessage(message);

        expect(messageSpy).toHaveBeenCalledWith(message);
        expect(rawSpy).toHaveBeenCalledWith(message);
        expect(orderbookSpy).toHaveBeenCalledWith(message);

        const stats = router.getStats();
        expect(stats.orderbookMessages).toBe(1);
        expect(stats.totalMessages).toBe(1);
      });

      it('should handle orderbook with empty bids/asks', () => {
        const orderbookSpy = jest.fn();
        router.on('orderbook', orderbookSpy);

        router.processMessage({
          event_type: 'book',
          asset_id: '123',
          bids: [],
          asks: [],
          timestamp: 123,
        });

        expect(orderbookSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe('Trade routing', () => {
      it('should emit trade event for trade message', () => {
        const tradeSpy = jest.fn();
        router.on('trade', tradeSpy);

        const message: PolymarketTradeMessage = {
          event_type: 'trade',
          asset_id: '123456789',
          price: '0.52',
          size: '50',
          side: 'BUY',
          timestamp: 1234567890,
        };

        router.processMessage(message);

        expect(tradeSpy).toHaveBeenCalledWith(message);

        const stats = router.getStats();
        expect(stats.tradeMessages).toBe(1);
      });

      it('should emit trade event for last_trade_price message', () => {
        const tradeSpy = jest.fn();
        router.on('trade', tradeSpy);

        router.processMessage({
          event_type: 'last_trade_price',
          asset_id: '123',
          price: '0.5',
          size: '10',
        });

        expect(tradeSpy).toHaveBeenCalledTimes(1);

        const stats = router.getStats();
        expect(stats.tradeMessages).toBe(1);
      });

      it('should not emit trade if price missing', () => {
        const tradeSpy = jest.fn();
        router.on('trade', tradeSpy);

        router.processMessage({
          event_type: 'trade',
          asset_id: '123',
          size: '10',
        });

        expect(tradeSpy).not.toHaveBeenCalled();
        expect(logger.warnCalls.some(c => c.message.includes('missing price/size'))).toBe(true);
      });

      it('should not emit trade if size missing', () => {
        const tradeSpy = jest.fn();
        router.on('trade', tradeSpy);

        router.processMessage({
          event_type: 'trade',
          asset_id: '123',
          price: '0.5',
        });

        expect(tradeSpy).not.toHaveBeenCalled();
      });

      it('should handle trade without side field', () => {
        const tradeSpy = jest.fn();
        router.on('trade', tradeSpy);

        router.processMessage({
          event_type: 'trade',
          asset_id: '123',
          price: '0.5',
          size: '10',
        });

        expect(tradeSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe('Control message routing', () => {
      it('should emit pong event', () => {
        const pongSpy = jest.fn();
        router.on('pong', pongSpy);

        router.processMessage({ event_type: 'pong' });

        expect(pongSpy).toHaveBeenCalledTimes(1);
      });

      it('should emit error event for error message', () => {
        const errorSpy = jest.fn();
        router.on('error', errorSpy);

        router.processMessage({
          event_type: 'error',
          message: 'Test error',
          data: { detail: 'error detail' },
        });

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));
        expect((errorSpy.mock.calls[0][0] as Error).message).toContain('error detail');
      });

      it('should emit subscribed event', () => {
        const subscribedSpy = jest.fn();
        router.on('subscribed', subscribedSpy);

        const message = {
          event_type: 'subscribed',
          channel: 'orderbook',
          params: { assets_ids: ['123'] },
        };

        router.processMessage(message);

        expect(subscribedSpy).toHaveBeenCalledWith(message);
      });

      it('should emit unsubscribed event', () => {
        const unsubscribedSpy = jest.fn();
        router.on('unsubscribed', unsubscribedSpy);

        const message = {
          event_type: 'unsubscribed',
          channel: 'orderbook',
        };

        router.processMessage(message);

        expect(unsubscribedSpy).toHaveBeenCalledWith(message);
      });
    });

    describe('Ignored messages', () => {
      it('should skip price_change events', () => {
        const messageSpy = jest.fn();
        router.on('message', messageSpy);

        router.processMessage({
          event_type: 'price_change',
          market: '123456',
          price_changes: [],
        });

        // message event still emitted
        expect(messageSpy).toHaveBeenCalledTimes(1);

        const stats = router.getStats();
        expect(stats.skippedMessages).toBe(1);
      });

      it('should skip tick_size_change events', () => {
        router.processMessage({
          event_type: 'tick_size_change',
          market: '123456',
        });

        const stats = router.getStats();
        expect(stats.skippedMessages).toBe(1);
      });
    });

    describe('Validation', () => {
      it('should warn if data message missing asset_id', () => {
        const orderbookSpy = jest.fn();
        router.on('orderbook', orderbookSpy);

        router.processMessage({
          event_type: 'book',
          bids: [],
          asks: [],
        });

        expect(orderbookSpy).not.toHaveBeenCalled();
        expect(logger.warnCalls.some(c => c.message.includes('without asset_id'))).toBe(true);
      });

      it('should use market field as fallback for asset_id', () => {
        const orderbookSpy = jest.fn();
        router.on('orderbook', orderbookSpy);

        router.processMessage({
          event_type: 'book',
          market: '123456',
          bids: [],
          asks: [],
        });

        expect(orderbookSpy).toHaveBeenCalledTimes(1);
      });

      it('should log unknown event types', () => {
        router.processMessage({
          event_type: 'unknown_type',
          asset_id: '123',
        });

        expect(logger.debugCalls.some(c => c.message.includes('Unknown event type'))).toBe(true);
      });
    });

    describe('Error handling', () => {
      it('should handle exceptions in message processing', () => {
        const errorSpy = jest.fn();
        router.on('error', errorSpy);

        // Simulate error by passing invalid data
        router.processMessage(null);

        expect(errorSpy).toHaveBeenCalled();
      });

      it('should continue processing after error', () => {
        const orderbookSpy = jest.fn();
        const errorSpy = jest.fn();
        router.on('orderbook', orderbookSpy);
        router.on('error', errorSpy); // Must handle error event

        // First message causes error
        router.processMessage(null);

        expect(errorSpy).toHaveBeenCalledTimes(1);

        // Second message should still work
        router.processMessage({
          event_type: 'book',
          asset_id: '123',
          bids: [],
          asks: [],
        });

        expect(orderbookSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Event emission', () => {
    it('should emit all event types correctly', () => {
      const events = {
        message: jest.fn(),
        raw: jest.fn(),
        orderbook: jest.fn(),
        trade: jest.fn(),
        pong: jest.fn(),
        error: jest.fn(),
        subscribed: jest.fn(),
        unsubscribed: jest.fn(),
      };

      Object.entries(events).forEach(([event, spy]) => {
        router.on(event, spy);
      });

      // Orderbook
      router.processMessage({
        event_type: 'book',
        asset_id: '123',
        bids: [],
        asks: [],
      });

      // Trade
      router.processMessage({
        event_type: 'trade',
        asset_id: '456',
        price: '0.5',
        size: '10',
      });

      // Control messages
      router.processMessage({ event_type: 'pong' });
      router.processMessage({ event_type: 'subscribed' });
      router.processMessage({ event_type: 'unsubscribed' });
      router.processMessage({ event_type: 'error', message: 'test' });

      expect(events.message).toHaveBeenCalledTimes(6);
      expect(events.raw).toHaveBeenCalledTimes(2); // orderbook + trade
      expect(events.orderbook).toHaveBeenCalledTimes(1);
      expect(events.trade).toHaveBeenCalledTimes(1);
      expect(events.pong).toHaveBeenCalledTimes(1);
      expect(events.subscribed).toHaveBeenCalledTimes(1);
      expect(events.unsubscribed).toHaveBeenCalledTimes(1);
      expect(events.error).toHaveBeenCalledTimes(1);
    });

    it('should pass correct data to event listeners', () => {
      const orderbookSpy = jest.fn();
      router.on('orderbook', orderbookSpy);

      const message = {
        event_type: 'book',
        asset_id: '123456789',
        bids: [{ price: '0.52', size: '100' }],
        asks: [{ price: '0.53', size: '150' }],
        timestamp: 1234567890,
      };

      router.processMessage(message);

      expect(orderbookSpy).toHaveBeenCalledWith(message);
      expect(orderbookSpy.mock.calls[0][0]).toEqual(message);
    });
  });

  describe('Statistics', () => {
    it('should track total messages', () => {
      router.processMessage({ event_type: 'book', asset_id: '123', bids: [], asks: [] });
      router.processMessage({ event_type: 'trade', asset_id: '456', price: '0.5', size: '10' });
      router.processMessage({ event_type: 'pong' });

      const stats = router.getStats();
      expect(stats.totalMessages).toBe(3);
    });

    it('should track orderbook messages', () => {
      router.processMessage({ event_type: 'book', asset_id: '1', bids: [], asks: [] });
      router.processMessage({ event_type: 'book', asset_id: '2', bids: [], asks: [] });
      router.processMessage({ event_type: 'trade', asset_id: '3', price: '0.5', size: '10' });

      const stats = router.getStats();
      expect(stats.orderbookMessages).toBe(2);
    });

    it('should track trade messages', () => {
      router.processMessage({ event_type: 'trade', asset_id: '1', price: '0.5', size: '10' });
      router.processMessage({ event_type: 'last_trade_price', asset_id: '2', price: '0.6', size: '20' });
      router.processMessage({ event_type: 'book', asset_id: '3', bids: [], asks: [] });

      const stats = router.getStats();
      expect(stats.tradeMessages).toBe(2);
    });

    it('should track parsing errors', () => {
      const errorSpy = jest.fn();
      router.on('error', errorSpy); // Must handle error event

      router.processRawData('invalid json');
      router.processRawData('{broken}');

      const stats = router.getStats();
      expect(stats.parsingErrors).toBe(2);
      expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('should track batch messages', () => {
      router.processRawData(JSON.stringify([{ event_type: 'pong' }]));
      router.processRawData(JSON.stringify([{ event_type: 'pong' }, { event_type: 'pong' }]));

      const stats = router.getStats();
      expect(stats.batchMessages).toBe(2);
    });

    it('should track skipped messages', () => {
      router.processMessage({ event_type: 'price_change', market: '123' });
      router.processMessage({ event_type: 'tick_size_change', market: '456' });

      const stats = router.getStats();
      expect(stats.skippedMessages).toBe(2);
    });

    it('should reset statistics', () => {
      router.processMessage({ event_type: 'book', asset_id: '123', bids: [], asks: [] });
      router.processMessage({ event_type: 'trade', asset_id: '456', price: '0.5', size: '10' });

      let stats = router.getStats();
      expect(stats.totalMessages).toBe(2);

      router.resetStats();

      stats = router.getStats();
      expect(stats.totalMessages).toBe(0);
      expect(stats.orderbookMessages).toBe(0);
      expect(stats.tradeMessages).toBe(0);
      expect(stats.parsingErrors).toBe(0);
      expect(stats.batchMessages).toBe(0);
      expect(stats.skippedMessages).toBe(0);
    });

    it('should return immutable stats copy', () => {
      const stats1 = router.getStats();
      const stats2 = router.getStats();

      expect(stats1).not.toBe(stats2);
      expect(stats1).toEqual(stats2);
    });
  });

  describe('Edge cases', () => {
    it('should handle message with type field instead of event_type', () => {
      const orderbookSpy = jest.fn();
      router.on('orderbook', orderbookSpy);

      router.processMessage({
        type: 'book',
        asset_id: '123',
        bids: [],
        asks: [],
      });

      expect(orderbookSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle very large messages', () => {
      const orderbookSpy = jest.fn();
      router.on('orderbook', orderbookSpy);

      const largeBids = Array.from({ length: 1000 }, (_, i) => ({
        price: `0.${i}`,
        size: `${i * 10}`,
      }));

      router.processMessage({
        event_type: 'book',
        asset_id: '123',
        bids: largeBids,
        asks: largeBids,
      });

      expect(orderbookSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle concurrent processRawData calls', () => {
      const orderbookSpy = jest.fn();
      router.on('orderbook', orderbookSpy);

      const message = JSON.stringify({
        event_type: 'book',
        asset_id: '123',
        bids: [],
        asks: [],
      });

      router.processRawData(message);
      router.processRawData(message);
      router.processRawData(message);

      expect(orderbookSpy).toHaveBeenCalledTimes(3);
    });

    it('should handle null/undefined in error message', () => {
      const errorSpy = jest.fn();
      router.on('error', errorSpy);

      router.processMessage({
        event_type: 'error',
        message: null,
        data: undefined,
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });
});
