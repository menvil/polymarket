/**
 * Unit tests for mapParsedToDomainEvent
 *
 * @remarks
 * Tests pure mapper function: PolymarketMessage → DomainEvent | null
 */

import { describe, it, expect } from '@jest/globals';
import { mapParsedToDomainEvent } from '../../../../../../src/infrastructure/polymarket/ws/mapping/mapParsedToDomainEvent.js';
import { OrderBookSnapshotReceivedEvent } from '../../../../../../src/domain/events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../../../../../../src/domain/events/TradeExecutedEvent.js';
import type {
  PolymarketOrderbookMessage,
  PolymarketTradeMessage,
  PolymarketControlMessage,
} from '../../../../../../src/infrastructure/polymarket/ws/PolymarketMessageRouter.js';

describe('mapParsedToDomainEvent', () => {
  const TEST_ASSET_ID = 'token-12345';

  describe('orderbook messages (book)', () => {
    it('should map valid book message to OrderBookSnapshotReceivedEvent', () => {
      // NOTE: Polymarket returns orderbooks in REVERSE order (worst → best)
      // The mapper will reverse these arrays to standard format (best → worst)
      const message: PolymarketOrderbookMessage = {
        event_type: 'book',
        asset_id: TEST_ASSET_ID,
        bids: [
          { price: '0.51', size: '200' },  // Худший bid (0.51 < 0.52)
          { price: '0.52', size: '100' },  // Лучший bid (0.52 > 0.51) - в конце массива
        ],
        asks: [
          { price: '0.54', size: '250' },  // Худший ask (0.54 > 0.53)
          { price: '0.53', size: '150' },  // Лучший ask (0.53 < 0.54) - в конце массива
        ],
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
      expect(event?.eventName).toBe('OrderBookSnapshotReceived');

      const bookEvent = event as OrderBookSnapshotReceivedEvent;
      expect(bookEvent.assetId).toBe(TEST_ASSET_ID);
      expect(bookEvent.bids.length).toBe(2);
      // After reversing: best bid (0.52) should be first
      expect(bookEvent.bids[0].price).toBe(0.52);
      expect(bookEvent.bids[0].size).toBe(100);
      expect(bookEvent.asks.length).toBe(2);
      // After reversing: best ask (0.53) should be first
      expect(bookEvent.asks[0].price).toBe(0.53);
      expect(bookEvent.asks[0].size).toBe(150);
      expect(bookEvent.timestamp.getTime()).toBe(1234567890);
    });

    it('should handle empty bids/asks arrays', () => {
      const message: PolymarketOrderbookMessage = {
        event_type: 'book',
        asset_id: TEST_ASSET_ID,
        bids: [],
        asks: [],
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
      const bookEvent = event as OrderBookSnapshotReceivedEvent;
      expect(bookEvent.bids.length).toBe(0);
      expect(bookEvent.asks.length).toBe(0);
    });

    it('should use current time if timestamp is undefined', () => {
      const message: any = {
        event_type: 'book',
        asset_id: TEST_ASSET_ID,
        bids: [],
        asks: [],
      };

      const before = Date.now();
      const event = mapParsedToDomainEvent(message);
      const after = Date.now();

      expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
      const bookEvent = event as OrderBookSnapshotReceivedEvent;
      const eventTime = bookEvent.timestamp.getTime();
      expect(eventTime).toBeGreaterThanOrEqual(before);
      expect(eventTime).toBeLessThanOrEqual(after);
    });

    it('should handle string timestamp', () => {
      const message: any = {
        event_type: 'book',
        asset_id: TEST_ASSET_ID,
        bids: [],
        asks: [],
        timestamp: '2024-01-01T12:00:00Z',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
      const bookEvent = event as OrderBookSnapshotReceivedEvent;
      expect(bookEvent.timestamp.toISOString()).toBe('2024-01-01T12:00:00.000Z');
    });

    it('should return null if asset_id is missing', () => {
      const message: any = {
        event_type: 'book',
        bids: [],
        asks: [],
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null if asset_id is empty string', () => {
      const message: any = {
        event_type: 'book',
        asset_id: '',
        bids: [],
        asks: [],
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null if bids is not an array', () => {
      const message: any = {
        event_type: 'book',
        asset_id: TEST_ASSET_ID,
        bids: 'not an array',
        asks: [],
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null if asks is not an array', () => {
      const message: any = {
        event_type: 'book',
        asset_id: TEST_ASSET_ID,
        bids: [],
        asks: null,
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null if any bid level has NaN price', () => {
      const message: any = {
        event_type: 'book',
        asset_id: TEST_ASSET_ID,
        bids: [
          { price: '0.52', size: '100' },
          { price: 'invalid', size: '200' },
        ],
        asks: [],
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null if any ask level has NaN size', () => {
      const message: any = {
        event_type: 'book',
        asset_id: TEST_ASSET_ID,
        bids: [],
        asks: [
          { price: '0.53', size: '150' },
          { price: '0.54', size: 'not a number' },
        ],
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should fallback to current time for invalid timestamp', () => {
      const message: any = {
        event_type: 'book',
        asset_id: TEST_ASSET_ID,
        bids: [],
        asks: [],
        timestamp: 'invalid date string',
      };

      const before = Date.now();
      const event = mapParsedToDomainEvent(message);
      const after = Date.now();

      expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
      const bookEvent = event as OrderBookSnapshotReceivedEvent;
      const eventTime = bookEvent.timestamp.getTime();
      expect(eventTime).toBeGreaterThanOrEqual(before);
      expect(eventTime).toBeLessThanOrEqual(after);
    });
  });

  describe('trade messages (trade)', () => {
    it('should map valid trade message to TradeExecutedEvent with BUY side', () => {
      const message: PolymarketTradeMessage = {
        event_type: 'trade',
        asset_id: TEST_ASSET_ID,
        price: '0.52',
        size: '50',
        side: 'BUY',
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeInstanceOf(TradeExecutedEvent);
      expect(event?.eventName).toBe('TradeExecuted');

      const tradeEvent = event as TradeExecutedEvent;
      expect(tradeEvent.assetId).toBe(TEST_ASSET_ID);
      expect(tradeEvent.price).toBe(0.52);
      expect(tradeEvent.size).toBe(50);
      expect(tradeEvent.side).toBe('BUY');
      expect(tradeEvent.timestamp.getTime()).toBe(1234567890);
    });

    it('should map valid trade message to TradeExecutedEvent with SELL side', () => {
      const message: PolymarketTradeMessage = {
        event_type: 'trade',
        asset_id: TEST_ASSET_ID,
        price: '0.65',
        size: '100',
        side: 'SELL',
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeInstanceOf(TradeExecutedEvent);
      const tradeEvent = event as TradeExecutedEvent;
      expect(tradeEvent.side).toBe('SELL');
    });

    it('should use current time if timestamp is undefined', () => {
      const message: any = {
        event_type: 'trade',
        asset_id: TEST_ASSET_ID,
        price: '0.52',
        size: '50',
        side: 'BUY',
      };

      const before = Date.now();
      const event = mapParsedToDomainEvent(message);
      const after = Date.now();

      expect(event).toBeInstanceOf(TradeExecutedEvent);
      const tradeEvent = event as TradeExecutedEvent;
      const eventTime = tradeEvent.timestamp.getTime();
      expect(eventTime).toBeGreaterThanOrEqual(before);
      expect(eventTime).toBeLessThanOrEqual(after);
    });

    it('should return null if asset_id is missing', () => {
      const message: any = {
        event_type: 'trade',
        price: '0.52',
        size: '50',
        side: 'BUY',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null if asset_id is empty string', () => {
      const message: any = {
        event_type: 'trade',
        asset_id: '',
        price: '0.52',
        size: '50',
        side: 'BUY',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null if price is NaN', () => {
      const message: any = {
        event_type: 'trade',
        asset_id: TEST_ASSET_ID,
        price: 'not a number',
        size: '50',
        side: 'BUY',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null if size is NaN', () => {
      const message: any = {
        event_type: 'trade',
        asset_id: TEST_ASSET_ID,
        price: '0.52',
        size: 'invalid',
        side: 'BUY',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should handle invalid side as null (not BUY or SELL)', () => {
      const message: any = {
        event_type: 'trade',
        asset_id: TEST_ASSET_ID,
        price: '0.52',
        size: '50',
        side: 'INVALID_SIDE',
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeInstanceOf(TradeExecutedEvent);
      const tradeEvent = event as TradeExecutedEvent;
      expect(tradeEvent.side).toBeNull();
    });
  });

  describe('last_trade_price messages', () => {
    it('should map last_trade_price to TradeExecutedEvent with null side', () => {
      const message: PolymarketTradeMessage = {
        event_type: 'last_trade_price',
        asset_id: TEST_ASSET_ID,
        price: '0.55',
        size: '75',
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeInstanceOf(TradeExecutedEvent);
      const tradeEvent = event as TradeExecutedEvent;
      expect(tradeEvent.assetId).toBe(TEST_ASSET_ID);
      expect(tradeEvent.price).toBe(0.55);
      expect(tradeEvent.size).toBe(75);
      expect(tradeEvent.side).toBeNull();
    });

    it('should handle last_trade_price with side field (use the side)', () => {
      const message: any = {
        event_type: 'last_trade_price',
        asset_id: TEST_ASSET_ID,
        price: '0.55',
        size: '75',
        side: 'SELL',
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeInstanceOf(TradeExecutedEvent);
      const tradeEvent = event as TradeExecutedEvent;
      expect(tradeEvent.side).toBe('SELL');
    });
  });

  describe('control messages', () => {
    it('should return null for pong message', () => {
      const message: PolymarketControlMessage = {
        event_type: 'pong',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null for subscribed message', () => {
      const message: PolymarketControlMessage = {
        event_type: 'subscribed',
        channel: 'market',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null for unsubscribed message', () => {
      const message: PolymarketControlMessage = {
        event_type: 'unsubscribed',
        channel: 'market',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null for error message', () => {
      const message: PolymarketControlMessage = {
        event_type: 'error',
        message: 'Something went wrong',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null for price_change message', () => {
      const message: PolymarketControlMessage = {
        event_type: 'price_change',
        market: 'some-market',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });

    it('should return null for tick_size_change message', () => {
      const message: PolymarketControlMessage = {
        event_type: 'tick_size_change',
        market: 'some-market',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle fractional price and size values', () => {
      const message: PolymarketTradeMessage = {
        event_type: 'trade',
        asset_id: TEST_ASSET_ID,
        price: '0.123456',
        size: '0.789',
        side: 'BUY',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeInstanceOf(TradeExecutedEvent);
      const tradeEvent = event as TradeExecutedEvent;
      expect(tradeEvent.price).toBeCloseTo(0.123456, 6);
      expect(tradeEvent.size).toBeCloseTo(0.789, 3);
    });

    it('should handle very large numbers', () => {
      const message: PolymarketOrderbookMessage = {
        event_type: 'book',
        asset_id: TEST_ASSET_ID,
        bids: [{ price: '999999.99', size: '1000000' }],
        asks: [],
        timestamp: 1234567890,
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
      const bookEvent = event as OrderBookSnapshotReceivedEvent;
      expect(bookEvent.bids[0].price).toBe(999999.99);
      expect(bookEvent.bids[0].size).toBe(1000000);
    });

    it('should handle zero price and size', () => {
      const message: PolymarketTradeMessage = {
        event_type: 'trade',
        asset_id: TEST_ASSET_ID,
        price: '0',
        size: '0',
        side: 'BUY',
      };

      const event = mapParsedToDomainEvent(message);

      expect(event).toBeInstanceOf(TradeExecutedEvent);
      const tradeEvent = event as TradeExecutedEvent;
      expect(tradeEvent.price).toBe(0);
      expect(tradeEvent.size).toBe(0);
    });
  });
});
