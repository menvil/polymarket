/**
 * Snapshot Event Normalizer Tests
 */

import { normalizeSnapshotEvent } from '../../../../../src/application/services/bucketizer/SnapshotEventNormalizer.js';
import { OrderBookSnapshotReceivedEvent } from '../../../../../src/domain/events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../../../../../src/domain/events/TradeExecutedEvent.js';

describe('SnapshotEventNormalizer', () => {
  describe('normalizeSnapshotEvent', () => {
    describe('valid book events', () => {
      it('should normalize valid book event with bids and asks', () => {
        // NOTE: Polymarket format - худшие → лучшие
        const line = JSON.stringify({
          event_type: 'book',
          asset_id: '0x123456',
          bids: [
            { price: '0.51', size: '200' },  // Худший bid
            { price: '0.52', size: '100' },  // Лучший bid
          ],
          asks: [
            { price: '0.54', size: '250' },  // Худший ask
            { price: '0.53', size: '150' },  // Лучший ask
          ],
          timestamp: 1766875759895,
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
        expect(event).not.toBeNull();

        const bookEvent = event as OrderBookSnapshotReceivedEvent;
        expect(bookEvent.assetId).toBe('0x123456');
        expect(bookEvent.bids).toHaveLength(2);
        expect(bookEvent.asks).toHaveLength(2);
        // После reverse - лучшие первыми
        expect(bookEvent.bids[0]).toEqual({ price: 0.52, size: 100 });
        expect(bookEvent.asks[0]).toEqual({ price: 0.53, size: 150 });
      });

      it('should normalize book event with empty bids/asks', () => {
        const line = JSON.stringify({
          event_type: 'book',
          asset_id: '0xabc',
          bids: [],
          asks: [],
          timestamp: 1234567890,
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
        const bookEvent = event as OrderBookSnapshotReceivedEvent;
        expect(bookEvent.bids).toHaveLength(0);
        expect(bookEvent.asks).toHaveLength(0);
      });

      it('should normalize book event without timestamp', () => {
        const line = JSON.stringify({
          event_type: 'book',
          asset_id: '0xdef',
          bids: [{ price: '0.5', size: '10' }],
          asks: [{ price: '0.6', size: '20' }],
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
        const bookEvent = event as OrderBookSnapshotReceivedEvent;
        expect(bookEvent.timestamp).toBeInstanceOf(Date);
      });
    });

    describe('valid trade events', () => {
      it('should normalize valid trade event with side', () => {
        const line = JSON.stringify({
          event_type: 'trade',
          asset_id: '0x789',
          price: '0.52',
          size: '50',
          side: 'BUY',
          timestamp: 1766875759895,
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeInstanceOf(TradeExecutedEvent);
        const tradeEvent = event as TradeExecutedEvent;
        expect(tradeEvent.assetId).toBe('0x789');
        expect(tradeEvent.price).toBe(0.52);
        expect(tradeEvent.size).toBe(50);
        expect(tradeEvent.side).toBe('BUY');
      });

      it('should normalize last_trade_price event without side', () => {
        const line = JSON.stringify({
          event_type: 'last_trade_price',
          asset_id: '0x456',
          price: '0.75',
          size: '100',
          timestamp: 1234567890,
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeInstanceOf(TradeExecutedEvent);
        const tradeEvent = event as TradeExecutedEvent;
        expect(tradeEvent.assetId).toBe('0x456');
        expect(tradeEvent.price).toBe(0.75);
        expect(tradeEvent.size).toBe(100);
        expect(tradeEvent.side).toBeNull();
      });

      it('should normalize SELL trade', () => {
        const line = JSON.stringify({
          event_type: 'trade',
          asset_id: '0xsell',
          price: '0.48',
          size: '200',
          side: 'SELL',
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeInstanceOf(TradeExecutedEvent);
        const tradeEvent = event as TradeExecutedEvent;
        expect(tradeEvent.side).toBe('SELL');
      });
    });

    describe('control messages', () => {
      it('should return null for pong message', () => {
        const line = JSON.stringify({
          event_type: 'pong',
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for subscribed message', () => {
        const line = JSON.stringify({
          event_type: 'subscribed',
          channel: 'book',
          asset_id: '0x123',
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for error message', () => {
        const line = JSON.stringify({
          event_type: 'error',
          message: 'Something went wrong',
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for price_change message', () => {
        const line = JSON.stringify({
          event_type: 'price_change',
          asset_id: '0x123',
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });
    });

    describe('invalid data', () => {
      it('should return null for invalid JSON', () => {
        const line = '{broken json}';

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for empty string', () => {
        const line = '';

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for non-object JSON', () => {
        const line = JSON.stringify('just a string');

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for null JSON', () => {
        const line = 'null';

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for array JSON', () => {
        const line = JSON.stringify([{ event_type: 'book' }]);

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for missing event_type', () => {
        const line = JSON.stringify({
          asset_id: '0x123',
          bids: [],
          asks: [],
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for non-string event_type', () => {
        const line = JSON.stringify({
          event_type: 123,
          asset_id: '0x123',
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });
    });

    describe('invalid event data', () => {
      it('should return null for book event with missing asset_id', () => {
        const line = JSON.stringify({
          event_type: 'book',
          bids: [],
          asks: [],
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for book event with empty asset_id', () => {
        const line = JSON.stringify({
          event_type: 'book',
          asset_id: '',
          bids: [],
          asks: [],
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for book event with non-array bids', () => {
        const line = JSON.stringify({
          event_type: 'book',
          asset_id: '0x123',
          bids: 'not an array',
          asks: [],
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for book event with invalid price', () => {
        const line = JSON.stringify({
          event_type: 'book',
          asset_id: '0x123',
          bids: [{ price: 'invalid', size: '100' }],
          asks: [],
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for trade event with missing price', () => {
        const line = JSON.stringify({
          event_type: 'trade',
          asset_id: '0x123',
          size: '100',
          side: 'BUY',
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should return null for trade event with NaN price', () => {
        const line = JSON.stringify({
          event_type: 'trade',
          asset_id: '0x123',
          price: 'not a number',
          size: '100',
          side: 'BUY',
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeNull();
      });

      it('should treat invalid side as null', () => {
        const line = JSON.stringify({
          event_type: 'trade',
          asset_id: '0x123',
          price: '0.5',
          size: '100',
          side: 'INVALID',
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeInstanceOf(TradeExecutedEvent);
        const tradeEvent = event as TradeExecutedEvent;
        expect(tradeEvent.side).toBeNull(); // Invalid side → null
      });
    });

    describe('edge cases', () => {
      it('should handle very long asset_id', () => {
        const longAssetId =
          '67704255197116168826604911233626301865010283966205730455742704536521111535950';
        const line = JSON.stringify({
          event_type: 'book',
          asset_id: longAssetId,
          bids: [],
          asks: [],
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
        const bookEvent = event as OrderBookSnapshotReceivedEvent;
        expect(bookEvent.assetId).toBe(longAssetId);
      });

      it('should handle very large orderbook', () => {
        const bids = Array.from({ length: 100 }, (_, i) => ({
          price: `${0.5 - i * 0.01}`,
          size: '100',
        }));

        const line = JSON.stringify({
          event_type: 'book',
          asset_id: '0x123',
          bids,
          asks: [],
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
        const bookEvent = event as OrderBookSnapshotReceivedEvent;
        expect(bookEvent.bids).toHaveLength(100);
      });

      it('should handle decimal prices and sizes', () => {
        const line = JSON.stringify({
          event_type: 'trade',
          asset_id: '0x123',
          price: '0.123456789',
          size: '0.0001',
          side: 'BUY',
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeInstanceOf(TradeExecutedEvent);
        const tradeEvent = event as TradeExecutedEvent;
        expect(tradeEvent.price).toBeCloseTo(0.123456789, 9);
        expect(tradeEvent.size).toBeCloseTo(0.0001, 4);
      });

      it('should handle string timestamp', () => {
        const line = JSON.stringify({
          event_type: 'book',
          asset_id: '0x123',
          bids: [],
          asks: [],
          timestamp: '2026-01-05T10:00:00Z',
        });

        const event = normalizeSnapshotEvent(line);

        expect(event).toBeInstanceOf(OrderBookSnapshotReceivedEvent);
        const bookEvent = event as OrderBookSnapshotReceivedEvent;
        expect(bookEvent.timestamp).toBeInstanceOf(Date);
      });
    });
  });
});
