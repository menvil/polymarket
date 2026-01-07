/**
 * Unit tests for ProjectorCoordinator
 *
 * @remarks
 * Tests EventBus → Projectors → State → Callbacks coordination.
 * Covers: subscriptions, event processing, error handling, callbacks.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ProjectorCoordinator } from '../../../../src/application/projectors/ProjectorCoordinator.js';
import { InMemoryEventBus } from '../../../../src/shared/events/InMemoryEventBus.js';
import { OrderBookSnapshotReceivedEvent } from '../../../../src/domain/events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../../../../src/domain/events/TradeExecutedEvent.js';
import { MarketDataErrorEvent } from '../../../../src/domain/events/MarketDataErrorEvent.js';
import type { Orderbook } from '../../../../src/domain/entities/Orderbook.js';
import type { Trade } from '../../../../src/domain/entities/Trade.js';
import type { ILogger } from '../../../../src/domain/ports/ILogger.js';

/**
 * Helper: Wait for next event loop tick (for async EventBus delivery)
 */
async function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}

describe('ProjectorCoordinator', () => {
  const TEST_ASSET_ID = 'asset-12345';

  let eventBus: InMemoryEventBus;
  let logger: ILogger;
  let projector: ProjectorCoordinator;

  beforeEach(() => {
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      silly: jest.fn(),
      trace: jest.fn(),
    } as unknown as ILogger;
    eventBus = new InMemoryEventBus(logger);
    projector = new ProjectorCoordinator(eventBus, logger);
  });

  describe('constructor', () => {
    it('should create projector and subscribe to EventBus', () => {
      expect(projector).toBeDefined();
      expect(projector.getTrackedAssetIds()).toEqual([]);
    });
  });

  describe('subscribeToOrderbook()', () => {
    it('should subscribe to orderbook updates', () => {
      const callback = jest.fn();
      const unsubscribe = projector.subscribeToOrderbook(TEST_ASSET_ID, callback);

      expect(unsubscribe).toBeInstanceOf(Function);
      expect(projector.getOrderbookSubscriberCount(TEST_ASSET_ID)).toBe(1);
    });

    it('should support multiple subscribers', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      projector.subscribeToOrderbook(TEST_ASSET_ID, callback1);
      projector.subscribeToOrderbook(TEST_ASSET_ID, callback2);

      expect(projector.getOrderbookSubscriberCount(TEST_ASSET_ID)).toBe(2);
    });

    it('should return working unsubscribe function', () => {
      const callback = jest.fn();
      const unsubscribe = projector.subscribeToOrderbook(TEST_ASSET_ID, callback);

      expect(projector.getOrderbookSubscriberCount(TEST_ASSET_ID)).toBe(1);

      unsubscribe();

      expect(projector.getOrderbookSubscriberCount(TEST_ASSET_ID)).toBe(0);
    });
  });

  describe('subscribeToTrades()', () => {
    it('should subscribe to trade updates', () => {
      const callback = jest.fn();
      const unsubscribe = projector.subscribeToTrades(TEST_ASSET_ID, callback);

      expect(unsubscribe).toBeInstanceOf(Function);
      expect(projector.getTradeSubscriberCount(TEST_ASSET_ID)).toBe(1);
    });

    it('should support multiple subscribers', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      projector.subscribeToTrades(TEST_ASSET_ID, callback1);
      projector.subscribeToTrades(TEST_ASSET_ID, callback2);

      expect(projector.getTradeSubscriberCount(TEST_ASSET_ID)).toBe(2);
    });

    it('should return working unsubscribe function', () => {
      const callback = jest.fn();
      const unsubscribe = projector.subscribeToTrades(TEST_ASSET_ID, callback);

      expect(projector.getTradeSubscriberCount(TEST_ASSET_ID)).toBe(1);

      unsubscribe();

      expect(projector.getTradeSubscriberCount(TEST_ASSET_ID)).toBe(0);
    });
  });

  describe('OrderBookSnapshotReceivedEvent processing', () => {
    it('should create aggregate and invoke callback', async () => {
      // GIVEN: Subscription
      const callback = jest.fn<(orderbook: Orderbook) => void>();
      projector.subscribeToOrderbook(TEST_ASSET_ID, callback);

      // WHEN: OrderBook event published
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [{ price: 0.52, size: 100 }],
        [{ price: 0.53, size: 150 }],
        new Date('2024-01-01T12:00:00Z')
      );
      eventBus.publish(event);
      await nextTick();

      // THEN: Callback invoked with Orderbook entity
      expect(callback).toHaveBeenCalledTimes(1);
      const orderbook = callback.mock.calls[0][0];
      expect(orderbook.marketId).toBe(TEST_ASSET_ID);
      expect(orderbook.getBestBid()?.value).toBe(0.52);
      expect(orderbook.getBestAsk()?.value).toBe(0.53);
    });

    it('should update aggregate state', async () => {
      // GIVEN: Event published
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [{ price: 0.52, size: 100 }],
        [{ price: 0.53, size: 150 }],
        new Date()
      );
      eventBus.publish(event);
      await nextTick();

      // THEN: Aggregate created and state updated
      const aggregate = projector.getAggregate(TEST_ASSET_ID);
      expect(aggregate).not.toBeNull();
      expect(aggregate!.getOrderbook()).not.toBeNull();
      expect(aggregate!.getOrderbook()!.getBestBid()?.value).toBe(0.52);
    });

    it('should invoke multiple callbacks', async () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      projector.subscribeToOrderbook(TEST_ASSET_ID, callback1);
      projector.subscribeToOrderbook(TEST_ASSET_ID, callback2);

      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [{ price: 0.52, size: 100 }],
        [{ price: 0.53, size: 150 }],
        new Date()
      );
      eventBus.publish(event);
      await nextTick();

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should not invoke callbacks if no subscription', async () => {
      const callback = jest.fn();
      // No subscription

      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        [],
        new Date()
      );
      eventBus.publish(event);
      await nextTick();

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle multiple assets independently', async () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      projector.subscribeToOrderbook('asset-1', callback1);
      projector.subscribeToOrderbook('asset-2', callback2);

      // Publish for asset-1
      const event1 = new OrderBookSnapshotReceivedEvent(
        'asset-1',
        [{ price: 0.50, size: 100 }],
        [],
        new Date()
      );
      eventBus.publish(event1);
      await nextTick();

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).not.toHaveBeenCalled();

      // Publish for asset-2
      const event2 = new OrderBookSnapshotReceivedEvent(
        'asset-2',
        [{ price: 0.60, size: 200 }],
        [],
        new Date()
      );
      eventBus.publish(event2);
      await nextTick();

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  describe('TradeExecutedEvent processing', () => {
    it('should create aggregate and invoke callback', async () => {
      // GIVEN: Subscription
      const callback = jest.fn<(trade: Trade) => void>();
      projector.subscribeToTrades(TEST_ASSET_ID, callback);

      // WHEN: Trade event published
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date('2024-01-01T12:00:00Z')
      );
      eventBus.publish(event);
      await nextTick();

      // THEN: Callback invoked with Trade entity
      expect(callback).toHaveBeenCalledTimes(1);
      const trade = callback.mock.calls[0][0];
      expect(trade.marketId).toBe(TEST_ASSET_ID);
      expect(trade.price.value).toBe(0.52);
      expect(trade.quantity.value).toBe(100);
      expect(trade.side).toBe('BUY');
    });

    it('should update aggregate state', async () => {
      // GIVEN: Event published
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'SELL',
        new Date()
      );
      eventBus.publish(event);
      await nextTick();

      // THEN: Aggregate created and state updated
      const aggregate = projector.getAggregate(TEST_ASSET_ID);
      expect(aggregate).not.toBeNull();
      expect(aggregate!.getLastTrade()).not.toBeNull();
      expect(aggregate!.getLastTrade()!.side).toBe('SELL');
    });

    it('should invoke multiple callbacks', async () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      projector.subscribeToTrades(TEST_ASSET_ID, callback1);
      projector.subscribeToTrades(TEST_ASSET_ID, callback2);

      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date()
      );
      eventBus.publish(event);
      await nextTick();

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  describe('invariant violation handling', () => {
    it('should emit MarketDataErrorEvent on time regression', async () => {
      // GIVEN: Aggregate with event at T2
      const event1 = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        [],
        new Date('2024-01-01T12:02:00Z')
      );
      eventBus.publish(event1);
      await nextTick();

      // WHEN: Event at T1 published (time regression)
      const errorCallback = jest.fn();
      eventBus.subscribe('MarketDataError', errorCallback);

      const event2 = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date('2024-01-01T12:00:00Z')
      );
      eventBus.publish(event2);
      await nextTick();

      // THEN: MarketDataErrorEvent emitted
      expect(errorCallback).toHaveBeenCalledTimes(1);
      const errorEvent = errorCallback.mock.calls[0][0] as MarketDataErrorEvent;
      expect(errorEvent).toBeInstanceOf(MarketDataErrorEvent);
      expect(errorEvent.assetId).toBe(TEST_ASSET_ID);
      expect(errorEvent.errorType).toBe('INVARIANT_VIOLATION');
      expect(errorEvent.message).toContain('Time regression');
    });

    it('should log warning on invariant violation', async () => {
      // GIVEN: Aggregate with event at T2
      eventBus.publish(
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [],
          [],
          new Date('2024-01-01T12:02:00Z')
        )
      );
      await nextTick();

      // WHEN: Time regression event
      eventBus.publish(
        new TradeExecutedEvent(
          TEST_ASSET_ID,
          0.52,
          100,
          'BUY',
          new Date('2024-01-01T12:00:00Z')
        )
      );
      await nextTick();

      // THEN: Warning logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Projection error'),
        expect.objectContaining({
          assetId: TEST_ASSET_ID,
          invariant: 'no_time_regression',
        })
      );
    });

    it('should not invoke callbacks on invariant violation', async () => {
      const orderbookCallback = jest.fn();
      const tradeCallback = jest.fn();

      projector.subscribeToOrderbook(TEST_ASSET_ID, orderbookCallback);
      projector.subscribeToTrades(TEST_ASSET_ID, tradeCallback);

      // GIVEN: Event at T2
      eventBus.publish(
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [],
          [],
          new Date('2024-01-01T12:02:00Z')
        )
      );
      await nextTick();

      expect(orderbookCallback).toHaveBeenCalledTimes(1);

      // WHEN: Event at T1 (time regression)
      eventBus.publish(
        new TradeExecutedEvent(
          TEST_ASSET_ID,
          0.52,
          100,
          'BUY',
          new Date('2024-01-01T12:00:00Z')
        )
      );
      await nextTick();

      // THEN: Trade callback not invoked (error occurred)
      expect(tradeCallback).not.toHaveBeenCalled();
    });

    it('should include event details in error event', async () => {
      // GIVEN: Event at T2
      const event1 = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        [],
        new Date('2024-01-01T12:02:00Z')
      );
      eventBus.publish(event1);
      await nextTick();

      // WHEN: Time regression
      const errorCallback = jest.fn();
      eventBus.subscribe('MarketDataError', errorCallback);

      const event2 = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date('2024-01-01T12:00:00Z')
      );
      eventBus.publish(event2);
      await nextTick();

      // THEN: Error event has details
      const errorEvent = errorCallback.mock.calls[0][0] as MarketDataErrorEvent;
      expect(errorEvent.details).toMatchObject({
        invariant: 'no_time_regression',
        eventName: 'TradeExecuted',
        eventId: event2.eventId,
      });
    });
  });

  describe('callback error isolation', () => {
    it('should isolate errors in orderbook callbacks', async () => {
      const callback1 = jest.fn(() => {
        throw new Error('Callback 1 error');
      });
      const callback2 = jest.fn();

      projector.subscribeToOrderbook(TEST_ASSET_ID, callback1);
      projector.subscribeToOrderbook(TEST_ASSET_ID, callback2);

      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [{ price: 0.52, size: 100 }],
        [{ price: 0.53, size: 150 }],
        new Date()
      );

      // Should not throw
      expect(() => eventBus.publish(event)).not.toThrow();
      await nextTick();

      // Both callbacks invoked despite error in callback1
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should isolate errors in trade callbacks', async () => {
      const callback1 = jest.fn(() => {
        throw new Error('Callback 1 error');
      });
      const callback2 = jest.fn();

      projector.subscribeToTrades(TEST_ASSET_ID, callback1);
      projector.subscribeToTrades(TEST_ASSET_ID, callback2);

      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date()
      );

      // Should not throw
      expect(() => eventBus.publish(event)).not.toThrow();
      await nextTick();

      // Both callbacks invoked
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  describe('getOrderbook()', () => {
    it('should return null if no aggregate', () => {
      const orderbook = projector.getOrderbook(TEST_ASSET_ID);
      expect(orderbook).toBeNull();
    });

    it('should return orderbook after event processed', async () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [{ price: 0.52, size: 100 }],
        [{ price: 0.53, size: 150 }],
        new Date()
      );
      eventBus.publish(event);
      await nextTick();

      const orderbook = projector.getOrderbook(TEST_ASSET_ID);
      expect(orderbook).not.toBeNull();
      expect(orderbook!.getBestBid()?.value).toBe(0.52);
    });
  });

  describe('getLastTrade()', () => {
    it('should return null if no aggregate', () => {
      const trade = projector.getLastTrade(TEST_ASSET_ID);
      expect(trade).toBeNull();
    });

    it('should return trade after event processed', async () => {
      const event = new TradeExecutedEvent(
        TEST_ASSET_ID,
        0.52,
        100,
        'BUY',
        new Date()
      );
      eventBus.publish(event);
      await nextTick();

      const trade = projector.getLastTrade(TEST_ASSET_ID);
      expect(trade).not.toBeNull();
      expect(trade!.price.value).toBe(0.52);
    });
  });

  describe('getAggregate()', () => {
    it('should return null if no aggregate', () => {
      const aggregate = projector.getAggregate(TEST_ASSET_ID);
      expect(aggregate).toBeNull();
    });

    it('should return aggregate after event processed', async () => {
      const event = new OrderBookSnapshotReceivedEvent(
        TEST_ASSET_ID,
        [],
        [],
        new Date()
      );
      eventBus.publish(event);
      await nextTick();

      const aggregate = projector.getAggregate(TEST_ASSET_ID);
      expect(aggregate).not.toBeNull();
      expect(aggregate!.assetId).toBe(TEST_ASSET_ID);
    });
  });

  describe('getTrackedAssetIds()', () => {
    it('should return empty array initially', () => {
      expect(projector.getTrackedAssetIds()).toEqual([]);
    });

    it('should return asset IDs with aggregates', async () => {
      eventBus.publish(
        new OrderBookSnapshotReceivedEvent('asset-1', [], [], new Date())
      );
      await nextTick();
      eventBus.publish(
        new TradeExecutedEvent('asset-2', 0.5, 100, 'BUY', new Date())
      );
      await nextTick();

      const assetIds = projector.getTrackedAssetIds();
      expect(assetIds).toContain('asset-1');
      expect(assetIds).toContain('asset-2');
      expect(assetIds.length).toBe(2);
    });
  });

  describe('clear()', () => {
    it('should clear all aggregates and callbacks', async () => {
      projector.subscribeToOrderbook(TEST_ASSET_ID, jest.fn());
      projector.subscribeToTrades(TEST_ASSET_ID, jest.fn());

      eventBus.publish(
        new OrderBookSnapshotReceivedEvent(TEST_ASSET_ID, [], [], new Date())
      );
      await nextTick();

      expect(projector.getTrackedAssetIds().length).toBe(1);
      expect(projector.getOrderbookSubscriberCount(TEST_ASSET_ID)).toBe(1);

      projector.clear();

      expect(projector.getTrackedAssetIds()).toEqual([]);
      expect(projector.getOrderbookSubscriberCount(TEST_ASSET_ID)).toBe(0);
      expect(projector.getTradeSubscriberCount(TEST_ASSET_ID)).toBe(0);
    });
  });

  describe('destroy()', () => {
    it('should unsubscribe from EventBus', async () => {
      const callback = jest.fn();
      projector.subscribeToOrderbook(TEST_ASSET_ID, callback);

      projector.destroy();

      // Publish event after destroy
      eventBus.publish(
        new OrderBookSnapshotReceivedEvent(TEST_ASSET_ID, [], [], new Date())
      );
      await nextTick();

      // Callback should not be invoked (projector destroyed)
      expect(callback).not.toHaveBeenCalled();
    });

    it('should clear all data', async () => {
      projector.subscribeToOrderbook(TEST_ASSET_ID, jest.fn());
      eventBus.publish(
        new OrderBookSnapshotReceivedEvent(TEST_ASSET_ID, [], [], new Date())
      );
      await nextTick();

      expect(projector.getTrackedAssetIds().length).toBe(1);

      projector.destroy();

      expect(projector.getTrackedAssetIds()).toEqual([]);
      expect(projector.getOrderbookSubscriberCount(TEST_ASSET_ID)).toBe(0);
    });

    it('should be idempotent', () => {
      projector.destroy();
      expect(() => projector.destroy()).not.toThrow();
    });
  });

  describe('integration scenarios', () => {
    it('should handle typical market data stream', async () => {
      const orderbookCallback = jest.fn();
      const tradeCallback = jest.fn();

      projector.subscribeToOrderbook(TEST_ASSET_ID, orderbookCallback);
      projector.subscribeToTrades(TEST_ASSET_ID, tradeCallback);

      // 1. Orderbook snapshot
      eventBus.publish(
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [{ price: 0.50, size: 100 }],
          [{ price: 0.51, size: 150 }],
          new Date('2024-01-01T12:00:00Z')
        )
      );
      await nextTick();

      // 2. Trade
      eventBus.publish(
        new TradeExecutedEvent(
          TEST_ASSET_ID,
          0.505,
          50,
          'BUY',
          new Date('2024-01-01T12:00:01Z')
        )
      );
      await nextTick();

      // 3. Updated orderbook
      eventBus.publish(
        new OrderBookSnapshotReceivedEvent(
          TEST_ASSET_ID,
          [{ price: 0.51, size: 120 }],
          [{ price: 0.52, size: 180 }],
          new Date('2024-01-01T12:00:02Z')
        )
      );
      await nextTick();

      expect(orderbookCallback).toHaveBeenCalledTimes(2);
      expect(tradeCallback).toHaveBeenCalledTimes(1);

      const latestOrderbook = projector.getOrderbook(TEST_ASSET_ID);
      expect(latestOrderbook!.getBestBid()?.value).toBe(0.51);
    });

    it('should handle multiple markets simultaneously', async () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      projector.subscribeToOrderbook('asset-1', callback1);
      projector.subscribeToOrderbook('asset-2', callback2);

      eventBus.publish(
        new OrderBookSnapshotReceivedEvent(
          'asset-1',
          [{ price: 0.50, size: 100 }],
          [],
          new Date()
        )
      );
      await nextTick();
      eventBus.publish(
        new OrderBookSnapshotReceivedEvent(
          'asset-2',
          [{ price: 0.60, size: 200 }],
          [],
          new Date()
        )
      );
      await nextTick();

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);

      expect(projector.getOrderbook('asset-1')!.getBestBid()?.value).toBe(0.50);
      expect(projector.getOrderbook('asset-2')!.getBestBid()?.value).toBe(0.60);
    });

    it('should handle unsubscribe and continue processing', async () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      projector.subscribeToOrderbook(TEST_ASSET_ID, callback1);
      const unsubscribe2 = projector.subscribeToOrderbook(TEST_ASSET_ID, callback2);

      // First event
      eventBus.publish(
        new OrderBookSnapshotReceivedEvent(TEST_ASSET_ID, [], [], new Date())
      );
      await nextTick();

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);

      // Unsubscribe callback2
      unsubscribe2();

      // Second event
      eventBus.publish(
        new OrderBookSnapshotReceivedEvent(TEST_ASSET_ID, [], [], new Date())
      );
      await nextTick();

      expect(callback1).toHaveBeenCalledTimes(2);
      expect(callback2).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe('ignores non-market-data events', () => {
    it('should ignore other domain events', async () => {
      const callback = jest.fn();
      projector.subscribeToOrderbook(TEST_ASSET_ID, callback);

      // Publish non-market-data event
      const otherEvent = {
        eventName: 'SomeOtherEvent',
        eventId: 'test-id',
        timestamp: new Date(),
      } as any;

      eventBus.publish(otherEvent);
      await nextTick();

      expect(callback).not.toHaveBeenCalled();
      expect(projector.getTrackedAssetIds()).toEqual([]);
    });
  });
});
