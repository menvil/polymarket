/**
 * E2E Test: Event-Driven Order Execution Flow
 *
 * @remarks
 * Тестирует полный цикл event-driven execution:
 * 1. placeOrder() → OrderPlacedEvent
 * 2. MetricsProjector/OrderRepositoryProjector update
 * 3. UserEventsFeedService tracking
 * 4. OrderFilled event → projector updates
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { InMemoryEventBus } from '../../../src/shared/events/InMemoryEventBus.js';
import { MetricsProjector } from '../../../src/application/projectors/MetricsProjector.js';
import { OrderRepositoryProjector } from '../../../src/application/projectors/OrderRepositoryProjector.js';
import { InMemoryOrderRepository } from '../../../src/infrastructure/persistence/repositories/InMemoryOrderRepository.js';
import { Order } from '../../../src/domain/entities/Order.js';
import { Price } from '../../../src/domain/value-objects/Price.js';
import { Quantity } from '../../../src/domain/value-objects/Quantity.js';
import { OrderPlacedEvent } from '../../../src/domain/events/OrderPlacedEvent.js';
import { OrderFilledEvent } from '../../../src/domain/events/OrderFilledEvent.js';
import { MockLogger } from '../../helpers/MockLogger.js';

/**
 * Helper: Wait for async event processing
 */
async function waitForEventProcessing(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('E2E: Event-Driven Order Execution', () => {
  let eventBus: InMemoryEventBus;
  let metricsProjector: MetricsProjector;
  let orderRepositoryProjector: OrderRepositoryProjector;
  let orderRepository: InMemoryOrderRepository;
  let logger: MockLogger;

  beforeEach(() => {
    logger = new MockLogger();
    eventBus = new InMemoryEventBus(logger);
    orderRepository = new InMemoryOrderRepository(logger);
    metricsProjector = new MetricsProjector(eventBus, logger);
    orderRepositoryProjector = new OrderRepositoryProjector(eventBus, orderRepository, logger);

    // Start projectors
    metricsProjector.start();
    orderRepositoryProjector.start();
  });

  describe('Full order execution flow', () => {
    it('should handle OrderPlaced → OrderFilled event flow', async () => {
      // Step 1: Create test order
      const order = Order.create({
        id: '0xorder123',
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: undefined,
      });

      // Step 2: Publish OrderPlacedEvent
      const placedEvent = new OrderPlacedEvent(order);
      eventBus.publish(placedEvent);

      // Wait for async event processing
      await waitForEventProcessing();

      // Step 3: Verify MetricsProjector updated
      const metricsAfterPlaced = metricsProjector.getMetrics();
      expect(metricsAfterPlaced.ordersPlaced).toBe(1);
      expect(metricsAfterPlaced.ordersFilled).toBe(0);
      expect(metricsAfterPlaced.ordersRejected).toBe(0);

      // Step 4: Verify OrderRepositoryProjector saved order
      const savedOrder = await orderRepository.findById('0xorder123');
      expect(savedOrder).not.toBeNull();
      expect(savedOrder?.status).toBe('PENDING');

      // Step 5: Simulate order fill (as a separate filled order event)
      const filledOrder = Order.create({
        id: '0xorder123_filled',
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'FILLED',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(100),
        averageFillPrice: Price.fromNumber(0.55),
      });

      const filledEvent = new OrderFilledEvent(
        filledOrder,
        Quantity.fromNumber(100), // fillSize
        Price.fromNumber(0.55)    // fillPrice
      );
      eventBus.publish(filledEvent);

      // Wait for async event processing
      await waitForEventProcessing();

      // Step 6: Verify MetricsProjector updated with fill
      const metricsAfterFilled = metricsProjector.getMetrics();
      expect(metricsAfterFilled.ordersPlaced).toBe(1);
      expect(metricsAfterFilled.ordersFilled).toBe(1);
      expect(metricsAfterFilled.fillRate).toBe(1.0);

      // Step 7: Verify OrderRepositoryProjector saved filled order
      const filledOrderFromRepo = await orderRepository.findById('0xorder123_filled');
      expect(filledOrderFromRepo).not.toBeNull();
      expect(filledOrderFromRepo?.status).toBe('FILLED');
      expect(filledOrderFromRepo?.filledSize?.value).toBe(100);
    });

    it('should track multiple orders independently', async () => {
      // Create and publish 3 orders
      for (let i = 1; i <= 3; i++) {
        const order = Order.create({
          id: `0xorder${i}`,
          tokenId: '0xtoken123',
          side: 'BUY',
          price: Price.fromNumber(0.55),
          size: Quantity.fromNumber(100),
          status: 'PENDING',
          timestamp: new Date(),
          filledSize: Quantity.fromNumber(0),
          averageFillPrice: undefined,
        });

        eventBus.publish(new OrderPlacedEvent(order));
      }

      await waitForEventProcessing();

      // Verify metrics
      const metrics = metricsProjector.getMetrics();
      expect(metrics.ordersPlaced).toBe(3);

      // Verify all orders saved
      const allOrders = await orderRepository.findAll();
      expect(allOrders.length).toBe(3);
    });

    it('should calculate fillRate correctly with partial fills', async () => {
      // Place 5 orders
      for (let i = 1; i <= 5; i++) {
        const order = Order.create({
          id: `0xorder_fill_${i}`,
          tokenId: '0xtoken123',
          side: 'BUY',
          price: Price.fromNumber(0.55),
          size: Quantity.fromNumber(100),
          status: 'PENDING',
          timestamp: new Date(),
          filledSize: Quantity.fromNumber(0),
          averageFillPrice: undefined,
        });

        eventBus.publish(new OrderPlacedEvent(order));
      }

      await waitForEventProcessing();

      // Fill only 3 orders (emulate new fills, not updates)
      for (let i = 1; i <= 3; i++) {
        const filledOrder = Order.create({
          id: `0xorder_filled_${i}`,
          tokenId: '0xtoken123',
          side: 'BUY',
          price: Price.fromNumber(0.55),
          size: Quantity.fromNumber(100),
          status: 'FILLED',
          timestamp: new Date(),
          filledSize: Quantity.fromNumber(100),
          averageFillPrice: Price.fromNumber(0.55),
        });

        eventBus.publish(new OrderFilledEvent(
          filledOrder,
          Quantity.fromNumber(100), // fillSize
          Price.fromNumber(0.55)    // fillPrice
        ));
      }

      await waitForEventProcessing();

      // Verify fillRate: 3 filled out of (5+3) total placed
      // NOTE: OrderFilledEvent triggers both OrderPlacedEvent behavior (counts as placed)
      const metrics = metricsProjector.getMetrics();
      expect(metrics.ordersPlaced).toBe(5); // Only OrderPlacedEvents count as placed
      expect(metrics.ordersFilled).toBe(3);
      expect(metrics.fillRate).toBe(0.6);
    });
  });

  describe('EventBus isolation', () => {
    it('should not interfere with other subscribers', async () => {
      const externalHandler = jest.fn();
      eventBus.subscribe('OrderPlaced', externalHandler);

      const order = Order.create({
        id: '0xorder123',
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: undefined,
      });

      eventBus.publish(new OrderPlacedEvent(order));

      await waitForEventProcessing();

      // Both projectors AND external handler should receive event
      expect(externalHandler).toHaveBeenCalledTimes(1);
      expect(metricsProjector.getMetrics().ordersPlaced).toBe(1);
    });
  });
});
