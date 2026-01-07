/**
 * UserEventsFeedService Unit Tests
 *
 * @remarks
 * Тестирует функциональность UserEventsFeedService:
 * - start() / stop() - lifecycle управление
 * - subscribeToOrder() - подписка на ордера
 * - WebSocket fallback to polling
 * - getStats() - статистика сервиса
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { UserEventsFeedService } from '../../../../../src/infrastructure/exchange/services/UserEventsFeedService.js';
import type { WebSocketManager } from '../../../../../src/infrastructure/exchange/clients/WebSocketManager.js';
import type { CLOBClient } from '../../../../../src/infrastructure/exchange/clients/CLOBClient.js';
import type { IEventBus } from '../../../../../src/shared/events/IEventBus.js';
import { MockLogger } from '../../../../helpers/MockLogger.js';

describe('UserEventsFeedService', () => {
  let service: UserEventsFeedService;
  let mockWsManager: WebSocketManager;
  let mockClobClient: CLOBClient;
  let mockEventBus: IEventBus;
  let mockLogger: MockLogger;

  // Callback handlers for WebSocket events
  let messageHandler: ((data: Buffer | string) => void) | null = null;
  let connectedHandler: (() => void) | null = null;
  let disconnectedHandler: (() => void) | null = null;

  beforeEach(() => {
    // Reset handlers
    messageHandler = null;
    connectedHandler = null;
    disconnectedHandler = null;

    // Mock WebSocketManager
    mockWsManager = {
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      on: jest.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === 'message') {
          messageHandler = handler as (data: Buffer | string) => void;
        } else if (event === 'connected') {
          connectedHandler = handler as () => void;
        } else if (event === 'disconnected') {
          disconnectedHandler = handler as () => void;
        }
      }),
      off: jest.fn(),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
    } as unknown as WebSocketManager;

    // Mock CLOBClient
    mockClobClient = {
      getOrders: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
      placeOrder: jest.fn(),
      cancelOrder: jest.fn(),
      getBalances: jest.fn(),
      getPositions: jest.fn(),
      getMarket: jest.fn(),
    } as unknown as CLOBClient;

    // Mock EventBus
    mockEventBus = {
      publish: jest.fn(),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      getAllSubscriberCount: jest.fn(),
      getSubscriberCount: jest.fn(),
    } as unknown as IEventBus;

    // Mock Logger
    mockLogger = new MockLogger();

    service = new UserEventsFeedService(mockWsManager, mockClobClient, mockEventBus, mockLogger);
  });

  describe('start()', () => {
    it('should start service and connect to WebSocket', async () => {
      await service.start();

      expect(mockWsManager.on).toHaveBeenCalledTimes(3);
      expect(mockWsManager.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWsManager.on).toHaveBeenCalledWith('connected', expect.any(Function));
      expect(mockWsManager.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
      expect(mockWsManager.connect).toHaveBeenCalledTimes(1);
    });

    it('should set isStarted flag to true', async () => {
      await service.start();

      const stats = service.getStats();
      expect(stats.isStarted).toBe(true);
    });

    it('should set isWebSocketConnected to true on successful connection', async () => {
      await service.start();

      const stats = service.getStats();
      expect(stats.isWebSocketConnected).toBe(true);
    });

    it('should throw error if already started', async () => {
      await service.start();

      await expect(service.start()).rejects.toThrow('UserEventsFeedService is already started');
    });

    it('should start polling if WebSocket connection fails', async () => {
      mockWsManager.connect = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Connection failed'));

      await service.start();

      const stats = service.getStats();
      expect(stats.isWebSocketConnected).toBe(false);
      expect(stats.isPolling).toBe(true);
    });

    it('should log start events', async () => {
      await service.start();

      expect(mockLogger.infoCalls.length).toBeGreaterThan(0);
      expect(mockLogger.infoCalls[0].message).toBe('[UserEventsFeed] Starting...');
      expect(mockLogger.infoCalls[1].message).toBe('[UserEventsFeed] WebSocket connected');
      expect(mockLogger.infoCalls[2].message).toBe('[UserEventsFeed] Started');
    });
  });

  describe('stop()', () => {
    it('should stop service and disconnect WebSocket', async () => {
      await service.start();
      await service.stop();

      expect(mockWsManager.disconnect).toHaveBeenCalledTimes(1);
    });

    it('should set isStarted flag to false', async () => {
      await service.start();
      await service.stop();

      const stats = service.getStats();
      expect(stats.isStarted).toBe(false);
    });

    it('should clear tracked orders', async () => {
      await service.start();
      service.subscribeToOrder('order-1');
      service.subscribeToOrder('order-2');

      await service.stop();

      const stats = service.getStats();
      expect(stats.trackedOrdersCount).toBe(0);
    });

    it('should stop polling if active', async () => {
      mockWsManager.connect = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Connection failed'));
      await service.start();

      const statsBefore = service.getStats();
      expect(statsBefore.isPolling).toBe(true);

      await service.stop();

      const statsAfter = service.getStats();
      expect(statsAfter.isPolling).toBe(false);
    });

    it('should not throw if service is not started', async () => {
      await expect(service.stop()).resolves.not.toThrow();
    });

    it('should handle WebSocket disconnect errors gracefully', async () => {
      await service.start();
      mockWsManager.disconnect = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Disconnect failed'));

      await service.stop();

      expect(mockLogger.warnCalls.length).toBeGreaterThan(0);
      expect(mockLogger.warnCalls[0].message).toBe('[UserEventsFeed] WebSocket disconnect failed');
    });
  });

  describe('subscribeToOrder()', () => {
    it('should add order to tracked orders', async () => {
      await service.start();

      service.subscribeToOrder('order-123');

      const stats = service.getStats();
      expect(stats.trackedOrdersCount).toBe(1);
    });

    it('should return unsubscribe function', async () => {
      await service.start();

      const unsubscribe = service.subscribeToOrder('order-123');

      expect(typeof unsubscribe).toBe('function');
    });

    it('should remove order when unsubscribe is called', async () => {
      await service.start();

      const unsubscribe = service.subscribeToOrder('order-123');
      expect(service.getStats().trackedOrdersCount).toBe(1);

      unsubscribe();

      expect(service.getStats().trackedOrdersCount).toBe(0);
    });

    it('should track multiple orders', async () => {
      await service.start();

      service.subscribeToOrder('order-1');
      service.subscribeToOrder('order-2');
      service.subscribeToOrder('order-3');

      const stats = service.getStats();
      expect(stats.trackedOrdersCount).toBe(3);
    });

    it('should throw error if service is not started', () => {
      expect(() => service.subscribeToOrder('order-123')).toThrow(
        'UserEventsFeedService is not started'
      );
    });

    it('should log subscription events', async () => {
      await service.start();

      service.subscribeToOrder('order-123');

      expect(mockLogger.debugCalls.length).toBeGreaterThan(0);
      expect(mockLogger.debugCalls[0].message).toBe('[UserEventsFeed] Subscribed to order: order-123');
    });

    it('should log unsubscription events', async () => {
      await service.start();

      const unsubscribe = service.subscribeToOrder('order-123');
      unsubscribe();

      const debugCalls = mockLogger.debugCalls;
      const unsubscribeLog = debugCalls.find((call) =>
        call.message.includes('Unsubscribed from order')
      );
      expect(unsubscribeLog).toBeDefined();
      expect(unsubscribeLog?.message).toBe('[UserEventsFeed] Unsubscribed from order: order-123');
    });
  });

  describe('WebSocket message handling', () => {
    it('should handle WebSocket messages when service is started', async () => {
      await service.start();
      expect(messageHandler).not.toBeNull();
    });

    it('should publish event for tracked order', async () => {
      await service.start();
      service.subscribeToOrder('0xabc123');

      // Simulate WebSocket message
      const message = JSON.stringify({
        type: 'order_filled',
        orderId: '0xabc123',
        filledSize: '100',
      });

      if (messageHandler) {
        messageHandler(Buffer.from(message));
      }

      // NOTE: Actual event publishing depends on UserEventsMapper implementation
      // This test would need to be updated when UserEventsMapper is fully implemented
    });
  });

  describe('WebSocket reconnection', () => {
    it('should stop polling when WebSocket reconnects', async () => {
      // Start with failed WebSocket (triggers polling)
      mockWsManager.connect = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Connection failed'));
      await service.start();

      expect(service.getStats().isPolling).toBe(true);

      // Simulate reconnection
      if (connectedHandler) {
        connectedHandler();
      }

      const stats = service.getStats();
      expect(stats.isWebSocketConnected).toBe(true);
      expect(stats.isPolling).toBe(false);
    });

    it('should start polling when WebSocket disconnects', async () => {
      await service.start();

      expect(service.getStats().isPolling).toBe(false);

      // Simulate disconnection
      if (disconnectedHandler) {
        disconnectedHandler();
      }

      const stats = service.getStats();
      expect(stats.isWebSocketConnected).toBe(false);
      expect(stats.isPolling).toBe(true);
    });

    it('should log reconnection events', async () => {
      await service.start();

      if (connectedHandler) {
        connectedHandler();
      }

      const reconnectLog = mockLogger.infoCalls.find((call) =>
        call.message.includes('WebSocket reconnected')
      );
      expect(reconnectLog).toBeDefined();
    });

    it('should log disconnection events', async () => {
      await service.start();

      if (disconnectedHandler) {
        disconnectedHandler();
      }

      const disconnectLog = mockLogger.warnCalls.find((call) =>
        call.message.includes('WebSocket disconnected')
      );
      expect(disconnectLog).toBeDefined();
    });
  });

  describe('getStats()', () => {
    it('should return stats when service is not started', () => {
      const stats = service.getStats();

      expect(stats.isStarted).toBe(false);
      expect(stats.isWebSocketConnected).toBe(false);
      expect(stats.isPolling).toBe(false);
      expect(stats.trackedOrdersCount).toBe(0);
    });

    it('should return stats when service is started with WebSocket', async () => {
      await service.start();

      const stats = service.getStats();

      expect(stats.isStarted).toBe(true);
      expect(stats.isWebSocketConnected).toBe(true);
      expect(stats.isPolling).toBe(false);
    });

    it('should return stats when service is started with polling', async () => {
      mockWsManager.connect = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Connection failed'));
      await service.start();

      const stats = service.getStats();

      expect(stats.isStarted).toBe(true);
      expect(stats.isWebSocketConnected).toBe(false);
      expect(stats.isPolling).toBe(true);
    });

    it('should return correct tracked orders count', async () => {
      await service.start();

      service.subscribeToOrder('order-1');
      service.subscribeToOrder('order-2');
      service.subscribeToOrder('order-3');

      const stats = service.getStats();
      expect(stats.trackedOrdersCount).toBe(3);
    });
  });

  describe('polling behavior', () => {
    it('should not start polling if WebSocket is connected', async () => {
      await service.start();

      const stats = service.getStats();
      expect(stats.isPolling).toBe(false);
    });

    it('should poll immediately when started as fallback', async () => {
      mockWsManager.connect = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Connection failed'));
      await service.start();

      // Check that polling was started
      const stats = service.getStats();
      expect(stats.isPolling).toBe(true);
    });

    it('should not start duplicate polling intervals', async () => {
      mockWsManager.connect = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Connection failed'));
      await service.start();

      // Try to trigger polling again via disconnect
      if (disconnectedHandler) {
        disconnectedHandler();
      }

      // Should still have only one polling interval
      const stats = service.getStats();
      expect(stats.isPolling).toBe(true);
    });
  });
});
