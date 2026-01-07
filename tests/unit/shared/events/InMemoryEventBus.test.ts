/**
 * Unit tests for InMemoryEventBus
 *
 * @remarks
 * Tests asynchronous event bus with error isolation, reentrancy protection, and FIFO delivery.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { InMemoryEventBus } from '../../../../src/shared/events/InMemoryEventBus.js';
import { OrderBookSnapshotReceivedEvent } from '../../../../src/domain/events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../../../../src/domain/events/TradeExecutedEvent.js';
import { MockLogger } from '../../../helpers/MockLogger.js';

/**
 * Helper: Wait for next event loop tick (setImmediate)
 *
 * @remarks
 * Используется для ожидания асинхронной доставки событий через setImmediate().
 */
async function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}

describe('InMemoryEventBus', () => {
  let bus: InMemoryEventBus;
  let logger: MockLogger;

  beforeEach(() => {
    logger = new MockLogger();
    bus = new InMemoryEventBus(logger);
  });

  describe('subscribe() and publish()', () => {
    it('should invoke handler when event is published (async)', async () => {
      const handler = jest.fn();
      bus.subscribe('OrderBookSnapshotReceived', handler);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [{ price: 0.52, size: 100 }],
        [{ price: 0.53, size: 150 }]
      );

      bus.publish(event);

      // Handler not called yet (async delivery)
      expect(handler).not.toHaveBeenCalled();

      // Wait for async delivery
      await nextTick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('should not invoke handler for different event type', async () => {
      const handler = jest.fn();
      bus.subscribe('TradeExecuted', handler);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('should invoke all subscribed handlers', async () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      const handler3 = jest.fn();

      bus.subscribe('OrderBookSnapshotReceived', handler1);
      bus.subscribe('OrderBookSnapshotReceived', handler2);
      bus.subscribe('OrderBookSnapshotReceived', handler3);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      // Contract: all handlers должны быть вызваны (порядок не гарантируется)
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
      expect(handler1).toHaveBeenCalledWith(event);
      expect(handler2).toHaveBeenCalledWith(event);
      expect(handler3).toHaveBeenCalledWith(event);
    });

    it('should allow same handler to subscribe multiple times', async () => {
      const handler = jest.fn();

      bus.subscribe('OrderBookSnapshotReceived', handler);
      bus.subscribe('OrderBookSnapshotReceived', handler);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      // Handler should be called twice (once per subscription)
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple event types', async () => {
      const orderbookHandler = jest.fn();
      const tradeHandler = jest.fn();

      bus.subscribe('OrderBookSnapshotReceived', orderbookHandler);
      bus.subscribe('TradeExecuted', tradeHandler);

      const orderbookEvent = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      const tradeEvent = new TradeExecutedEvent(
        'token-123',
        0.52,
        50,
        'BUY'
      );

      bus.publish(orderbookEvent);
      bus.publish(tradeEvent);
      await nextTick();

      expect(orderbookHandler).toHaveBeenCalledTimes(1);
      expect(orderbookHandler).toHaveBeenCalledWith(orderbookEvent);
      expect(tradeHandler).toHaveBeenCalledTimes(1);
      expect(tradeHandler).toHaveBeenCalledWith(tradeEvent);
    });
  });

  describe('unsubscribe()', () => {
    it('should unsubscribe handler', async () => {
      const handler = jest.fn();
      const unsubscribe = bus.subscribe('OrderBookSnapshotReceived', handler);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();
      expect(handler).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      bus.publish(event);
      await nextTick();
      expect(handler).toHaveBeenCalledTimes(1); // Still 1 (not called again)
    });

    it('should unsubscribe only specific handler instance', async () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      const unsubscribe1 = bus.subscribe('OrderBookSnapshotReceived', handler1);
      bus.subscribe('OrderBookSnapshotReceived', handler2);

      // Unsubscribe only handler1
      unsubscribe1();

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should allow calling unsubscribe multiple times', async () => {
      const handler = jest.fn();
      const unsubscribe = bus.subscribe('OrderBookSnapshotReceived', handler);

      unsubscribe();
      unsubscribe();
      unsubscribe();

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle unsubscribe when handler was subscribed multiple times', async () => {
      const handler = jest.fn();

      const unsubscribe1 = bus.subscribe('OrderBookSnapshotReceived', handler);
      const unsubscribe2 = bus.subscribe('OrderBookSnapshotReceived', handler);

      // Unsubscribe first subscription
      unsubscribe1();

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      // Should still be called once (second subscription)
      expect(handler).toHaveBeenCalledTimes(1);

      // Unsubscribe second subscription
      unsubscribe2();

      bus.publish(event);
      await nextTick();

      // Should not be called anymore
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribeAll()', () => {
    it('should invoke handler for any event', async () => {
      const handler = jest.fn();
      bus.subscribeAll(handler);

      const orderbookEvent = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      const tradeEvent = new TradeExecutedEvent(
        'token-456',
        0.52,
        50,
        'BUY'
      );

      bus.publish(orderbookEvent);
      bus.publish(tradeEvent);
      await nextTick();

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, orderbookEvent);
      expect(handler).toHaveBeenNthCalledWith(2, tradeEvent);
    });

    it('should invoke both specific and "all" handlers', async () => {
      const specificHandler = jest.fn();
      const allHandler = jest.fn();

      bus.subscribe('OrderBookSnapshotReceived', specificHandler);
      bus.subscribeAll(allHandler);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      expect(specificHandler).toHaveBeenCalledTimes(1);
      expect(allHandler).toHaveBeenCalledTimes(1);
      expect(specificHandler).toHaveBeenCalledWith(event);
      expect(allHandler).toHaveBeenCalledWith(event);
    });

    it('should invoke both specific and "all" handlers', async () => {
      const specificHandler = jest.fn();
      const allHandler = jest.fn();

      bus.subscribe('OrderBookSnapshotReceived', specificHandler);
      bus.subscribeAll(allHandler);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      // Contract: both handlers должны быть вызваны (порядок не гарантируется)
      expect(specificHandler).toHaveBeenCalledTimes(1);
      expect(allHandler).toHaveBeenCalledTimes(1);
      expect(specificHandler).toHaveBeenCalledWith(event);
      expect(allHandler).toHaveBeenCalledWith(event);
    });

    it('should unsubscribe "all" handler', async () => {
      const handler = jest.fn();
      const unsubscribe = bus.subscribeAll(handler);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();
      expect(handler).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      bus.publish(event);
      await nextTick();
      expect(handler).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should invoke all "all" handlers', async () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      const handler3 = jest.fn();

      bus.subscribeAll(handler1);
      bus.subscribeAll(handler2);
      bus.subscribeAll(handler3);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      // Contract: все "all" handlers должны быть вызваны (порядок не гарантируется)
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
    });
  });

  describe('error isolation', () => {
    it('should not throw if handler throws error', async () => {
      const errorHandler = jest.fn(() => {
        throw new Error('Handler error');
      });

      bus.subscribe('OrderBookSnapshotReceived', errorHandler);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      expect(() => {
        bus.publish(event);
      }).not.toThrow();

      await nextTick();

      expect(errorHandler).toHaveBeenCalledTimes(1);

      // Contract: ошибка должна быть залогирована через ILogger
      expect(logger.errorCalls).toHaveLength(1);
      expect(logger.errorCalls[0].message).toBe('[EventBus] Handler error');
      expect(logger.errorCalls[0].meta.error).toBe('Handler error');
      expect(logger.errorCalls[0].meta.eventName).toBe('OrderBookSnapshotReceived');
    });

    it('should continue invoking other handlers if one throws', async () => {
      const handler1 = jest.fn();
      const errorHandler = jest.fn(() => {
        throw new Error('Handler 2 error');
      });
      const handler3 = jest.fn();

      bus.subscribe('OrderBookSnapshotReceived', handler1);
      bus.subscribe('OrderBookSnapshotReceived', errorHandler);
      bus.subscribe('OrderBookSnapshotReceived', handler3);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      // All handlers should be invoked despite error in handler2
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
    });

    it('should isolate errors in "all" handlers', async () => {
      const handler1 = jest.fn();
      const errorHandler = jest.fn(() => {
        throw new Error('All handler error');
      });
      const handler2 = jest.fn();

      bus.subscribeAll(handler1);
      bus.subscribeAll(errorHandler);
      bus.subscribeAll(handler2);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should isolate errors between specific and "all" handlers', async () => {
      const specificHandler = jest.fn(() => {
        throw new Error('Specific handler error');
      });
      const allHandler = jest.fn();

      bus.subscribe('OrderBookSnapshotReceived', specificHandler);
      bus.subscribeAll(allHandler);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      expect(specificHandler).toHaveBeenCalledTimes(1);
      expect(allHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('utility methods', () => {
    it('should return correct subscriber count', () => {
      expect(bus.getSubscriberCount('OrderBookSnapshotReceived')).toBe(0);

      bus.subscribe('OrderBookSnapshotReceived', jest.fn());
      expect(bus.getSubscriberCount('OrderBookSnapshotReceived')).toBe(1);

      bus.subscribe('OrderBookSnapshotReceived', jest.fn());
      expect(bus.getSubscriberCount('OrderBookSnapshotReceived')).toBe(2);

      expect(bus.getSubscriberCount('TradeExecuted')).toBe(0);
    });

    it('should return correct "all" subscriber count', () => {
      expect(bus.getAllSubscriberCount()).toBe(0);

      bus.subscribeAll(jest.fn());
      expect(bus.getAllSubscriberCount()).toBe(1);

      bus.subscribeAll(jest.fn());
      expect(bus.getAllSubscriberCount()).toBe(2);
    });

    it('should update counts after unsubscribe', () => {
      const unsubscribe1 = bus.subscribe('OrderBookSnapshotReceived', jest.fn());
      const unsubscribe2 = bus.subscribe('OrderBookSnapshotReceived', jest.fn());

      expect(bus.getSubscriberCount('OrderBookSnapshotReceived')).toBe(2);

      unsubscribe1();
      expect(bus.getSubscriberCount('OrderBookSnapshotReceived')).toBe(1);

      unsubscribe2();
      expect(bus.getSubscriberCount('OrderBookSnapshotReceived')).toBe(0);
    });

    it('should clear all subscriptions', () => {
      bus.subscribe('OrderBookSnapshotReceived', jest.fn());
      bus.subscribe('TradeExecuted', jest.fn());
      bus.subscribeAll(jest.fn());

      expect(bus.getSubscriberCount('OrderBookSnapshotReceived')).toBe(1);
      expect(bus.getSubscriberCount('TradeExecuted')).toBe(1);
      expect(bus.getAllSubscriberCount()).toBe(1);

      bus.clear();

      expect(bus.getSubscriberCount('OrderBookSnapshotReceived')).toBe(0);
      expect(bus.getSubscriberCount('TradeExecuted')).toBe(0);
      expect(bus.getAllSubscriberCount()).toBe(0);
    });

    it('should not invoke handlers after clear()', async () => {
      const handler = jest.fn();
      bus.subscribe('OrderBookSnapshotReceived', handler);
      bus.subscribeAll(handler);

      bus.clear();

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle publish with no subscribers', async () => {
      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      expect(() => {
        bus.publish(event);
      }).not.toThrow();

      await nextTick();
      // No assertions needed - just checking it doesn't throw
    });

    it('should handle rapid subscribe/unsubscribe', () => {
      const handler = jest.fn();

      for (let i = 0; i < 100; i++) {
        const unsubscribe = bus.subscribe('OrderBookSnapshotReceived', handler);
        unsubscribe();
      }

      expect(bus.getSubscriberCount('OrderBookSnapshotReceived')).toBe(0);
    });

    it('should handle many subscribers', async () => {
      const handlers: Array<jest.Mock> = [];

      for (let i = 0; i < 100; i++) {
        const handler = jest.fn();
        handlers.push(handler);
        bus.subscribe('OrderBookSnapshotReceived', handler);
      }

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      bus.publish(event);
      await nextTick();

      handlers.forEach(handler => {
        expect(handler).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('async behavior', () => {
    it('should return immediately from publish() without blocking', () => {
      const handler = jest.fn();
      bus.subscribe('OrderBookSnapshotReceived', handler);

      const event = new OrderBookSnapshotReceivedEvent(
        'token-123',
        [],
        []
      );

      // publish() должен вернуться мгновенно (synchronous)
      const startTime = Date.now();
      bus.publish(event);
      const endTime = Date.now();

      // Должен вернуться практически мгновенно (< 10ms)
      expect(endTime - startTime).toBeLessThan(10);

      // Handler НЕ вызван ещё
      expect(handler).not.toHaveBeenCalled();
    });

    it('should deliver all published events', async () => {
      const receivedEvents: string[] = [];

      bus.subscribe('OrderBookSnapshotReceived', (event) => {
        receivedEvents.push(event.eventId);
      });

      const event1 = new OrderBookSnapshotReceivedEvent('token-1', [], []);
      const event2 = new OrderBookSnapshotReceivedEvent('token-2', [], []);
      const event3 = new OrderBookSnapshotReceivedEvent('token-3', [], []);

      bus.publish(event1);
      bus.publish(event2);
      bus.publish(event3);

      await nextTick();

      // Contract: все события должны быть доставлены (порядок не гарантируется)
      expect(receivedEvents).toHaveLength(3);
      expect(receivedEvents).toContain(event1.eventId);
      expect(receivedEvents).toContain(event2.eventId);
      expect(receivedEvents).toContain(event3.eventId);
    });

    it('should handle reentrancy (subscriber calling publish)', async () => {
      const handler1Calls: string[] = [];
      const handler2Calls: string[] = [];
      let firstEventId: string | null = null;
      let nestedEventId: string | null = null;

      bus.subscribe('OrderBookSnapshotReceived', (event) => {
        const assetId = (event as OrderBookSnapshotReceivedEvent).assetId;
        handler1Calls.push(assetId);

        // Subscriber вызывает publish() внутри обработки первого события
        if (assetId === 'token-1') {
          firstEventId = event.eventId;
          const nestedEvent = new OrderBookSnapshotReceivedEvent('nested', [], []);
          nestedEventId = nestedEvent.eventId;
          bus.publish(nestedEvent); // Reentrancy!
        }
      });

      bus.subscribe('OrderBookSnapshotReceived', (event) => {
        const assetId = (event as OrderBookSnapshotReceivedEvent).assetId;
        handler2Calls.push(assetId);
      });

      const event1 = new OrderBookSnapshotReceivedEvent('token-1', [], []);
      bus.publish(event1);

      await nextTick();

      // Contract: reentrancy должна работать без stack overflow
      // Оба события должны быть обработаны обоими handlers (порядок не гарантируется)
      expect(handler1Calls).toHaveLength(2);
      expect(handler1Calls).toContain('token-1');
      expect(handler1Calls).toContain('nested');

      expect(handler2Calls).toHaveLength(2);
      expect(handler2Calls).toContain('token-1');
      expect(handler2Calls).toContain('nested');

      expect(firstEventId).toBeTruthy();
      expect(nestedEventId).toBeTruthy();
    });

    it('should handle multiple rapid publishes without stack overflow', async () => {
      const handler = jest.fn();
      bus.subscribe('OrderBookSnapshotReceived', handler);

      const event = new OrderBookSnapshotReceivedEvent('token-123', [], []);

      // Публикуем 1000 событий подряд
      for (let i = 0; i < 1000; i++) {
        bus.publish(event);
      }

      await nextTick();

      // Все обработчики должны быть вызваны
      expect(handler).toHaveBeenCalledTimes(1000);
    });
  });

});
