/**
 * DiagnosticsService Unit Tests
 *
 * @remarks
 * Тестирует функциональность DiagnosticsService:
 * - getHealth() - проверка статусов компонентов
 * - getDiagnostics() - полный snapshot
 * - getExecutionMetrics() - метрики исполнения
 * - getStateSnapshot() - состояние системы
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { DiagnosticsService } from '../../../../src/infrastructure/diagnostics/DiagnosticsService.js';
import type { IEventBus } from '../../../../src/shared/events/IEventBus.js';
import type { MetricsProjector } from '../../../../src/application/projectors/MetricsProjector.js';
import type { UserEventsFeedService } from '../../../../src/infrastructure/exchange/services/UserEventsFeedService.js';
import type { IOrderRepository } from '../../../../src/domain/ports/IOrderRepository.js';
import type { Order } from '../../../../src/domain/entities/Order.js';
import { MockLogger } from '../../../helpers/MockLogger.js';

describe('DiagnosticsService', () => {
  let diagnostics: DiagnosticsService;
  let mockEventBus: IEventBus;
  let mockMetricsProjector: MetricsProjector;
  let mockUserEventsFeed: UserEventsFeedService;
  let mockOrderRepository: IOrderRepository;
  let mockLogger: MockLogger;

  beforeEach(() => {
    // Mock EventBus
    mockEventBus = {
      getAllSubscriberCount: jest.fn().mockReturnValue(5),
      getSubscriberCount: jest.fn((eventType: string) => {
        const counts: Record<string, number> = {
          OrderPlaced: 2,
          OrderFilled: 3,
          OrderCancelled: 1,
        };
        return counts[eventType] || 0;
      }),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      publish: jest.fn(),
    } as unknown as IEventBus;

    // Mock MetricsProjector
    mockMetricsProjector = {
      getMetrics: jest.fn().mockReturnValue({
        ordersPlaced: 10,
        ordersFilled: 7,
        ordersRejected: 2,
        fillRate: 0.7,
      }),
      start: jest.fn(),
    } as unknown as MetricsProjector;

    // Mock UserEventsFeedService
    mockUserEventsFeed = {
      getStats: jest.fn().mockReturnValue({
        isStarted: true,
        isWebSocketConnected: true,
        isPolling: false,
        trackedOrdersCount: 5,
      }),
      start: jest.fn(),
      stop: jest.fn(),
      trackOrder: jest.fn(),
      untrackOrder: jest.fn(),
    } as unknown as UserEventsFeedService;

    // Mock OrderRepository
    mockOrderRepository = {
      findAll: jest.fn<() => Promise<Order[]>>().mockResolvedValue([
        { id: '1', status: 'OPEN' },
        { id: '2', status: 'PENDING' },
        { id: '3', status: 'FILLED' },
      ] as Order[]),
      findById: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as unknown as IOrderRepository;

    // Mock Logger
    mockLogger = new MockLogger();

    diagnostics = new DiagnosticsService(
      mockEventBus,
      mockMetricsProjector,
      mockUserEventsFeed,
      mockOrderRepository,
      mockLogger
    );
  });

  describe('getHealth()', () => {
    it('should return healthy status when all components are healthy', async () => {
      const health = await diagnostics.getHealth();

      expect(health.status).toBe('healthy');
      expect(health.components).toHaveLength(3);
      expect(health.timestamp).toBeInstanceOf(Date);
    });

    it('should check EventBus health', async () => {
      const health = await diagnostics.getHealth();

      const eventBusHealth = health.components.find((c) => c.name === 'EventBus');
      expect(eventBusHealth).toBeDefined();
      expect(eventBusHealth?.status).toBe('healthy');
      expect(eventBusHealth?.message).toContain('5 subscribers active');
    });

    it('should mark EventBus as degraded when no subscribers', async () => {
      mockEventBus.getAllSubscriberCount = jest.fn<() => number>().mockReturnValue(0);

      const health = await diagnostics.getHealth();

      const eventBusHealth = health.components.find((c) => c.name === 'EventBus');
      expect(eventBusHealth?.status).toBe('degraded');
      expect(eventBusHealth?.message).toContain('No subscribers registered');
    });

    it('should check UserEventsFeed health when WebSocket connected', async () => {
      const health = await diagnostics.getHealth();

      const feedHealth = health.components.find((c) => c.name === 'UserEventsFeed');
      expect(feedHealth).toBeDefined();
      expect(feedHealth?.status).toBe('healthy');
      expect(feedHealth?.message).toBe('WebSocket connected');
    });

    it('should mark UserEventsFeed as degraded when polling fallback active', async () => {
      mockUserEventsFeed.getStats = jest.fn<() => { isStarted: boolean; isWebSocketConnected: boolean; isPolling: boolean; trackedOrdersCount: number }>().mockReturnValue({
        isStarted: true,
        isWebSocketConnected: false,
        isPolling: true,
        trackedOrdersCount: 5,
      });

      const health = await diagnostics.getHealth();

      const feedHealth = health.components.find((c) => c.name === 'UserEventsFeed');
      expect(feedHealth?.status).toBe('degraded');
      expect(feedHealth?.message).toBe('Polling fallback active');
    });

    it('should mark UserEventsFeed as unhealthy when not started', async () => {
      mockUserEventsFeed.getStats = jest.fn<() => { isStarted: boolean; isWebSocketConnected: boolean; isPolling: boolean; trackedOrdersCount: number }>().mockReturnValue({
        isStarted: false,
        isWebSocketConnected: false,
        isPolling: false,
        trackedOrdersCount: 0,
      });

      const health = await diagnostics.getHealth();

      const feedHealth = health.components.find((c) => c.name === 'UserEventsFeed');
      expect(feedHealth?.status).toBe('unhealthy');
      expect(feedHealth?.message).toBe('Service not started');
    });

    it('should check OrderRepository health', async () => {
      const health = await diagnostics.getHealth();

      const repoHealth = health.components.find((c) => c.name === 'OrderRepository');
      expect(repoHealth).toBeDefined();
      expect(repoHealth?.status).toBe('healthy');
      expect(repoHealth?.message).toContain('3 orders in repository');
    });

    it('should mark OrderRepository as unhealthy on error', async () => {
      mockOrderRepository.findAll = jest.fn<() => Promise<Order[]>>().mockRejectedValue(new Error('Database error'));

      const health = await diagnostics.getHealth();

      const repoHealth = health.components.find((c) => c.name === 'OrderRepository');
      expect(repoHealth?.status).toBe('unhealthy');
      expect(repoHealth?.message).toBe('Database error');
    });

    it('should calculate overall status as unhealthy if any component is unhealthy', async () => {
      mockOrderRepository.findAll = jest.fn<() => Promise<Order[]>>().mockRejectedValue(new Error('Error'));

      const health = await diagnostics.getHealth();

      expect(health.status).toBe('unhealthy');
    });

    it('should calculate overall status as degraded if any component is degraded', async () => {
      mockEventBus.getAllSubscriberCount = jest.fn<() => number>().mockReturnValue(0);

      const health = await diagnostics.getHealth();

      expect(health.status).toBe('degraded');
    });
  });

  describe('getExecutionMetrics()', () => {
    it('should return execution metrics from MetricsProjector', async () => {
      const metrics = await diagnostics.getExecutionMetrics();

      expect(metrics.ordersPlaced).toBe(10);
      expect(metrics.ordersFilled).toBe(7);
      expect(metrics.ordersRejected).toBe(2);
      expect(metrics.fillRate).toBe(0.7);
    });

    it('should call MetricsProjector.getMetrics()', async () => {
      await diagnostics.getExecutionMetrics();

      expect(mockMetricsProjector.getMetrics).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStateSnapshot()', () => {
    it('should return state snapshot with active orders count', async () => {
      const state = await diagnostics.getStateSnapshot();

      expect(state.activeOrders).toBe(2); // OPEN + PENDING
      expect(state.timestamp).toBeInstanceOf(Date);
    });

    it('should count only PENDING and OPEN orders as active', async () => {
      mockOrderRepository.findAll = jest.fn<() => Promise<Order[]>>().mockResolvedValue([
        { id: '1', status: 'OPEN' },
        { id: '2', status: 'PENDING' },
        { id: '3', status: 'FILLED' },
        { id: '4', status: 'CANCELLED' },
        { id: '5', status: 'OPEN' },
      ] as Order[]);

      const state = await diagnostics.getStateSnapshot();

      expect(state.activeOrders).toBe(3); // 2 OPEN + 1 PENDING
    });

    it('should include user events subscription count', async () => {
      const state = await diagnostics.getStateSnapshot();

      expect(state.subscriptions.userEvents).toBe(5);
    });

    it('should include placeholder values for tracked markets and orderbook/trades subscriptions', async () => {
      const state = await diagnostics.getStateSnapshot();

      expect(state.trackedMarkets).toBe(0);
      expect(state.subscriptions.orderbook).toBe(0);
      expect(state.subscriptions.trades).toBe(0);
    });
  });

  describe('getDiagnostics()', () => {
    it('should return full diagnostics snapshot', async () => {
      const snapshot = await diagnostics.getDiagnostics();

      expect(snapshot.health).toBeDefined();
      expect(snapshot.executionMetrics).toBeDefined();
      expect(snapshot.eventBusMetrics).toBeDefined();
      expect(snapshot.userEventsFeedStats).toBeDefined();
      expect(snapshot.adaptersHealth).toBeDefined();
      expect(snapshot.state).toBeDefined();
      expect(snapshot.timestamp).toBeInstanceOf(Date);
    });

    it('should include EventBus metrics', async () => {
      const snapshot = await diagnostics.getDiagnostics();

      expect(snapshot.eventBusMetrics.totalSubscribers).toBeGreaterThan(0);
      expect(snapshot.eventBusMetrics.allEventsSubscribers).toBe(5);
      expect(snapshot.eventBusMetrics.subscribersByEvent).toBeDefined();
      expect(snapshot.eventBusMetrics.subscribersByEvent.OrderPlaced).toBe(2);
      expect(snapshot.eventBusMetrics.subscribersByEvent.OrderFilled).toBe(3);
    });

    it('should include UserEventsFeed stats', async () => {
      const snapshot = await diagnostics.getDiagnostics();

      expect(snapshot.userEventsFeedStats.isStarted).toBe(true);
      expect(snapshot.userEventsFeedStats.isWebSocketConnected).toBe(true);
      expect(snapshot.userEventsFeedStats.isPolling).toBe(false);
      expect(snapshot.userEventsFeedStats.trackedOrdersCount).toBe(5);
    });

    it('should include adapters health', async () => {
      const snapshot = await diagnostics.getDiagnostics();

      expect(snapshot.adaptersHealth.executionAdapter.available).toBe(true);
      expect(snapshot.adaptersHealth.portfolioAdapter.available).toBe(true);
      expect(snapshot.adaptersHealth.marketDataFeed.available).toBe(true);
    });

    it('should collect all data in parallel', async () => {
      const startTime = Date.now();
      await diagnostics.getDiagnostics();
      const endTime = Date.now();

      // Should be fast (< 100ms) if running in parallel
      expect(endTime - startTime).toBeLessThan(100);
    });
  });

  describe('error handling', () => {
    it('should handle EventBus errors gracefully', async () => {
      mockEventBus.getAllSubscriberCount = jest.fn<() => number>().mockImplementation(() => {
        throw new Error('EventBus error');
      });

      const health = await diagnostics.getHealth();

      const eventBusHealth = health.components.find((c) => c.name === 'EventBus');
      expect(eventBusHealth?.status).toBe('unhealthy');
      expect(eventBusHealth?.message).toBe('EventBus error');
    });

    it('should handle UserEventsFeed errors gracefully', async () => {
      mockUserEventsFeed.getStats = jest.fn<() => { isStarted: boolean; isWebSocketConnected: boolean; isPolling: boolean; trackedOrdersCount: number }>().mockImplementation(() => {
        throw new Error('Feed error');
      });

      const health = await diagnostics.getHealth();

      const feedHealth = health.components.find((c) => c.name === 'UserEventsFeed');
      expect(feedHealth?.status).toBe('unhealthy');
      expect(feedHealth?.message).toBe('Feed error');
    });

    it('should log debug messages', async () => {
      await diagnostics.getHealth();

      expect(mockLogger.debugCalls.length).toBeGreaterThan(0);
      expect(mockLogger.debugCalls[0].message).toBe('[Diagnostics] Collecting health status...');
      expect(mockLogger.debugCalls[1].message).toContain('[Diagnostics] Health status:');
    });
  });
});
