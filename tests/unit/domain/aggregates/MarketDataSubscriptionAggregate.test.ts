/**
 * Unit tests for MarketDataSubscriptionAggregate
 *
 * @remarks
 * Tests event-sourced aggregate with Given/When/Then pattern.
 * Covers: apply(), replay(), invariants, state projection.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { MarketDataSubscriptionAggregate } from '../../../../src/domain/aggregates/MarketDataSubscriptionAggregate.js';
import { OrderBookSnapshotReceivedEvent } from '../../../../src/domain/events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../../../../src/domain/events/TradeExecutedEvent.js';

describe('MarketDataSubscriptionAggregate', () => {
  const TEST_ASSET_ID = 'asset-12345';

  describe('create()', () => {
    it('should create aggregate with assetId', () => {
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);

      expect(aggregate.assetId).toBe(TEST_ASSET_ID);
      expect(aggregate.getOrderbook()).toBeNull();
      expect(aggregate.getLastTrade()).toBeNull();
      expect(aggregate.getLastEventTime()).toBeNull();
    });

    it('should throw if assetId is empty', () => {
      expect(() => {
        MarketDataSubscriptionAggregate.create('');
      }).toThrow('Asset ID cannot be empty');
    });

    it('should throw if assetId is whitespace', () => {
      expect(() => {
        MarketDataSubscriptionAggregate.create('   ');
      }).toThrow('Asset ID cannot be empty');
    });
  });

  describe('apply() - OrderBookSnapshotReceivedEvent', () => {
    let aggregate: MarketDataSubscriptionAggregate;

    beforeEach(() => {
      aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);
    });

    it('should build Orderbook entity from event', () => {
      // GIVEN: Aggregate with no state
      expect(aggregate.getOrderbook()).toBeNull();

      // WHEN: OrderBookSnapshotReceivedEvent applied
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [{ price: 0.52, size: 100 }],
        [{ price: 0.53, size: 150 }],
        new Date('2024-01-01T12:00:00Z')
      );
      aggregate.apply(event);

      // THEN: Orderbook entity created
      const orderbook = aggregate.getOrderbook();
      expect(orderbook).not.toBeNull();
      expect(orderbook!.marketId).toBe(TEST_ASSET_ID);
      expect(orderbook!.getBestBid()?.value).toBe(0.52);
      expect(orderbook!.getBestAsk()?.value).toBe(0.53);
      expect(orderbook!.timestamp).toEqual(new Date('2024-01-01T12:00:00Z'));
    });

    it('should update lastEventTime', () => {
      // GIVEN: Aggregate with no state
      expect(aggregate.getLastEventTime()).toBeNull();

      // WHEN: Event applied
      const timestamp = new Date('2024-01-01T12:00:00Z');
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        [],
        timestamp
      );
      aggregate.apply(event);

      // THEN: lastEventTime updated
      expect(aggregate.getLastEventTime()).toEqual(timestamp);
    });

    it('should handle empty bids/asks', () => {
      // WHEN: Event with empty arrays
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        [],
        new Date()
      );
      aggregate.apply(event);

      // THEN: Orderbook created but empty
      const orderbook = aggregate.getOrderbook();
      expect(orderbook).not.toBeNull();
      expect(orderbook!.isEmpty()).toBe(true);
      expect(orderbook!.getBestBid()).toBeNull();
      expect(orderbook!.getBestAsk()).toBeNull();
    });

    it('should replace previous orderbook', () => {
      // GIVEN: Aggregate with orderbook
      const event1 = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [{ price: 0.50, size: 100 }],
        [{ price: 0.51, size: 150 }],
        new Date('2024-01-01T12:00:00Z')
      );
      aggregate.apply(event1);
      expect(aggregate.getOrderbook()!.getBestBid()?.value).toBe(0.50);

      // WHEN: New orderbook event applied
      const event2 = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [{ price: 0.52, size: 200 }],
        [{ price: 0.53, size: 250 }],
        new Date('2024-01-01T12:01:00Z')
      );
      aggregate.apply(event2);

      // THEN: Orderbook replaced
      expect(aggregate.getOrderbook()!.getBestBid()?.value).toBe(0.52);
    });
  });

  describe('apply() - TradeExecutedEvent', () => {
    let aggregate: MarketDataSubscriptionAggregate;

    beforeEach(() => {
      aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);
    });

    it('should build Trade entity from event', () => {
      // GIVEN: Aggregate with no trade
      expect(aggregate.getLastTrade()).toBeNull();

      // WHEN: TradeExecutedEvent applied
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date('2024-01-01T12:00:00Z')
      );
      aggregate.apply(event);

      // THEN: Trade entity created
      const trade = aggregate.getLastTrade();
      expect(trade).not.toBeNull();
      expect(trade!.marketId).toBe(TEST_ASSET_ID);
      expect(trade!.price.value).toBe(0.52);
      expect(trade!.quantity.value).toBe(100);
      expect(trade!.side).toBe('BUY');
      expect(trade!.timestamp).toEqual(new Date('2024-01-01T12:00:00Z'));
    });

    it('should generate unique trade ID', () => {
      // WHEN: Two trade events applied
      const event1 = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date('2024-01-01T12:00:00Z')
      );
      const event2 = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.53,
        150,
        'SELL',
        new Date('2024-01-01T12:01:00Z')
      );

      aggregate.apply(event1);
      const trade1Id = aggregate.getLastTrade()!.id;

      aggregate.apply(event2);
      const trade2Id = aggregate.getLastTrade()!.id;

      // THEN: Trade IDs are unique
      expect(trade1Id).not.toBe(trade2Id);
      expect(trade1Id).toContain(TEST_ASSET_ID);
      expect(trade2Id).toContain(TEST_ASSET_ID);
    });

    it('should handle null side (last_trade_price)', () => {
      // WHEN: Trade with null side
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        null,
        new Date()
      );
      aggregate.apply(event);

      // THEN: Trade created with null side
      const trade = aggregate.getLastTrade();
      expect(trade).not.toBeNull();
      expect(trade!.side).toBeNull();
    });

    it('should replace previous trade', () => {
      // GIVEN: Aggregate with trade
      const event1 = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.50,
        100,
        'BUY',
        new Date('2024-01-01T12:00:00Z')
      );
      aggregate.apply(event1);
      expect(aggregate.getLastTrade()!.price.value).toBe(0.50);

      // WHEN: New trade event applied
      const event2 = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        150,
        'SELL',
        new Date('2024-01-01T12:01:00Z')
      );
      aggregate.apply(event2);

      // THEN: Trade replaced
      expect(aggregate.getLastTrade()!.price.value).toBe(0.52);
      expect(aggregate.getLastTrade()!.side).toBe('SELL');
    });
  });

  describe('invariant: no time regression', () => {
    let aggregate: MarketDataSubscriptionAggregate;

    beforeEach(() => {
      aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);
    });

    it('should accept events with increasing timestamps', () => {
      // GIVEN: Events in chronological order
      const event1 = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        [],
        new Date('2024-01-01T12:00:00Z')
      );
      const event2 = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date('2024-01-01T12:01:00Z')
      );
      const event3 = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        [],
        new Date('2024-01-01T12:02:00Z')
      );

      // WHEN: Applied in order
      aggregate.apply(event1);
      aggregate.apply(event2);
      aggregate.apply(event3);

      // THEN: No error thrown
      expect(aggregate.getLastEventTime()).toEqual(
        new Date('2024-01-01T12:02:00Z')
      );
    });

    it('should accept events with equal timestamps', () => {
      // GIVEN: Events at same time
      const timestamp = new Date('2024-01-01T12:00:00Z');
      const event1 = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        [],
        timestamp
      );
      const event2 = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        timestamp
      );

      // WHEN: Applied with same timestamp
      aggregate.apply(event1);
      aggregate.apply(event2);

      // THEN: No error thrown (equal time is allowed)
      expect(aggregate.getLastEventTime()).toEqual(timestamp);
    });

    it('should reject event with earlier timestamp', () => {
      // GIVEN: Aggregate with event at T2
      const event1 = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        [],
        new Date('2024-01-01T12:02:00Z')
      );
      aggregate.apply(event1);

      // WHEN: Event with earlier timestamp T1 applied
      const event2 = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date('2024-01-01T12:00:00Z')
      );

      // THEN: Applied = false, invariant violation
      const result = aggregate.apply(event2);
      expect(result.applied).toBe(false);
      expect(result.invariant).toBe('no_time_regression');
      expect(result.error).toContain('Time regression detected');
    });

    it('should include timestamps in error message', () => {
      // GIVEN: Event at T2
      aggregate.apply(
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [],
          [],
          new Date('2024-01-01T12:02:00.000Z')
        )
      );

      // WHEN: Event at T1 applied
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date('2024-01-01T12:00:00.000Z')
      );

      // THEN: Error includes both timestamps
      const result = aggregate.apply(event);
      expect(result.applied).toBe(false);
      expect(result.error).toContain('2024-01-01T12:02:00.000Z');
      expect(result.error).toContain('2024-01-01T12:00:00.000Z');
      expect(result.invariant).toBe('no_time_regression');
    });
  });

  describe('trade acceptance', () => {
    it('should accept trades with any price (no spread check)', () => {
      // GIVEN: Aggregate with orderbook [bid=0.52, ask=0.53]
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);
      const orderbookEvent = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [{ price: 0.52, size: 100 }],
        [{ price: 0.53, size: 150 }],
        new Date('2024-01-01T12:00:00Z')
      );
      aggregate.apply(orderbookEvent);

      // WHEN: Trades at various prices (including outside spread)
      const trades = [
        0.51, // Below bid (market order, race condition, etc)
        0.52, // At bid
        0.525, // Inside spread
        0.53, // At ask
        0.54, // Above ask (aggressive buy, orderbook lag, etc)
      ];

      // THEN: All trades accepted (they are valid by definition from exchange)
      for (const price of trades) {
        const event = new TradeExecutedEvent(
          TEST_ASSET_ID,
          price,
          100,
          'BUY',
          new Date('2024-01-01T12:01:00Z')
        );
        const result = aggregate.apply(event);
        expect(result.applied).toBe(true);
      }
    });

    it('should accept trade without orderbook', () => {
      // GIVEN: Fresh aggregate with no orderbook
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);

      // WHEN: Trade with any price
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.99,
        100,
        'BUY',
        new Date()
      );

      // THEN: Trade accepted
      const result = aggregate.apply(event);
      expect(result.applied).toBe(true);
    });
  });

  describe('replay()', () => {
    it('should replay events in order', () => {
      // GIVEN: Sequence of events
      const events = [
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [{ price: 0.50, size: 100 }],
          [{ price: 0.51, size: 150 }],
          new Date('2024-01-01T12:00:00Z')
        ),
        new TradeExecutedEvent(
          TEST_ASSET_ID,
          0.505,
          50,
          'BUY',
          new Date('2024-01-01T12:01:00Z')
        ),
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [{ price: 0.52, size: 200 }],
          [{ price: 0.53, size: 250 }],
          new Date('2024-01-01T12:02:00Z')
        ),
      ];

      // WHEN: Replayed
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);
      aggregate.replay(events);

      // THEN: Final state reflects all events
      expect(aggregate.getOrderbook()!.getBestBid()?.value).toBe(0.52);
      expect(aggregate.getOrderbook()!.getBestAsk()?.value).toBe(0.53);
      expect(aggregate.getLastTrade()!.price.value).toBe(0.505);
      expect(aggregate.getLastEventTime()).toEqual(
        new Date('2024-01-01T12:02:00Z')
      );
    });

    it('should handle empty event array', () => {
      // WHEN: Replay with no events
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);
      aggregate.replay([]);

      // THEN: No state change
      expect(aggregate.getOrderbook()).toBeNull();
      expect(aggregate.getLastTrade()).toBeNull();
      expect(aggregate.getLastEventTime()).toBeNull();
    });

    it('should enforce invariants during replay', () => {
      // GIVEN: Events with time regression
      const events = [
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [],
          [],
          new Date('2024-01-01T12:02:00Z')
        ),
        new TradeExecutedEvent(
          TEST_ASSET_ID,
          0.52,
          100,
          'BUY',
          new Date('2024-01-01T12:00:00Z') // Earlier!
        ),
      ];

      // WHEN: Replayed
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);
      const results = aggregate.replay(events);

      // THEN: First event applied, second rejected
      expect(results).toHaveLength(2);
      expect(results[0].applied).toBe(true);
      expect(results[1].applied).toBe(false);
      expect(results[1].invariant).toBe('no_time_regression');
    });
  });

  describe('getStatus()', () => {
    it('should return status with no data', () => {
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);

      const status = aggregate.getStatus();

      expect(status.assetId).toBe(TEST_ASSET_ID);
      expect(status.hasOrderbook).toBe(false);
      expect(status.hasTrade).toBe(false);
      expect(status.lastEventTime).toBeNull();
      expect(status.orderbook).toBeNull();
      expect(status.lastTrade).toBeNull();
    });

    it('should return status with orderbook', () => {
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [{ price: 0.52, size: 100 }],
        [{ price: 0.53, size: 150 }],
        new Date('2024-01-01T12:00:00Z')
      );
      aggregate.apply(event);

      const status = aggregate.getStatus();

      expect(status.hasOrderbook).toBe(true);
      expect(status.orderbook).not.toBeNull();
      expect(status.orderbook!.bestBid).toBe(0.52);
      expect(status.orderbook!.bestAsk).toBe(0.53);
    });

    it('should return status with trade', () => {
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date('2024-01-01T12:00:00Z')
      );
      aggregate.apply(event);

      const status = aggregate.getStatus();

      expect(status.hasTrade).toBe(true);
      expect(status.lastTrade).not.toBeNull();
      expect(status.lastTrade!.price).toBe(0.52);
      expect(status.lastTrade!.side).toBe('BUY');
    });

    it('should return status with both orderbook and trade', () => {
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);

      const bookEvent = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [{ price: 0.52, size: 100 }],
        [{ price: 0.53, size: 150 }],
        new Date('2024-01-01T12:00:00Z')
      );
      const tradeEvent = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.525,
        50,
        'BUY',
        new Date('2024-01-01T12:01:00Z')
      );

      aggregate.apply(bookEvent);
      aggregate.apply(tradeEvent);

      const status = aggregate.getStatus();

      expect(status.hasOrderbook).toBe(true);
      expect(status.hasTrade).toBe(true);
      expect(status.lastEventTime).toBe('2024-01-01T12:01:00.000Z');
    });
  });

  describe('integration scenarios', () => {
    it('should handle typical market data stream', () => {
      // GIVEN: Fresh aggregate
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);

      // WHEN: Typical sequence of events
      // 1. Initial orderbook snapshot
      aggregate.apply(
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [{ price: 0.50, size: 100 }],
          [{ price: 0.51, size: 150 }],
          new Date('2024-01-01T12:00:00.000Z')
        )
      );

      // 2. Trade inside spread
      aggregate.apply(
        new TradeExecutedEvent(
          TEST_ASSET_ID,
          0.505,
          50,
          'BUY',
          new Date('2024-01-01T12:00:01.000Z')
        )
      );

      // 3. Updated orderbook
      aggregate.apply(
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [{ price: 0.51, size: 120 }],
          [{ price: 0.52, size: 180 }],
          new Date('2024-01-01T12:00:02.000Z')
        )
      );

      // 4. Another trade
      aggregate.apply(
        new TradeExecutedEvent(
          TEST_ASSET_ID,
          0.52,
          75,
          'BUY',
          new Date('2024-01-01T12:00:03.000Z')
        )
      );

      // THEN: State reflects latest data
      expect(aggregate.getOrderbook()!.getBestBid()?.value).toBe(0.51);
      expect(aggregate.getOrderbook()!.getBestAsk()?.value).toBe(0.52);
      expect(aggregate.getLastTrade()!.price.value).toBe(0.52);
      expect(aggregate.getLastTrade()!.side).toBe('BUY');
    });

    it('should handle market with no trades (orderbook only)', () => {
      // GIVEN: Aggregate
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);

      // WHEN: Only orderbook events (no trades)
      aggregate.apply(
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [{ price: 0.50, size: 100 }],
          [{ price: 0.51, size: 150 }],
          new Date('2024-01-01T12:00:00Z')
        )
      );
      aggregate.apply(
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [{ price: 0.52, size: 120 }],
          [{ price: 0.53, size: 180 }],
          new Date('2024-01-01T12:01:00Z')
        )
      );

      // THEN: Has orderbook but no trades
      expect(aggregate.getOrderbook()).not.toBeNull();
      expect(aggregate.getLastTrade()).toBeNull();
    });

    it('should handle trade before orderbook', () => {
      // GIVEN: Aggregate
      const aggregate = MarketDataSubscriptionAggregate.create(TEST_ASSET_ID);

      // WHEN: Trade comes before orderbook
      aggregate.apply(
        new TradeExecutedEvent(
          TEST_ASSET_ID,
          0.52,
          100,
          'BUY',
          new Date('2024-01-01T12:00:00Z')
        )
      );

      // THEN: Trade accepted (no spread to check)
      expect(aggregate.getLastTrade()).not.toBeNull();
      expect(aggregate.getOrderbook()).toBeNull();

      // WHEN: Orderbook arrives later
      aggregate.apply(
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [{ price: 0.51, size: 100 }],
          [{ price: 0.53, size: 150 }],
          new Date('2024-01-01T12:01:00Z')
        )
      );

      // THEN: Both present
      expect(aggregate.getOrderbook()).not.toBeNull();
      expect(aggregate.getLastTrade()).not.toBeNull();
    });
  });
});
