/**
 * DiagnosticsService - реализация IDiagnosticsService
 *
 * @remarks
 * Собирает диагностическую информацию из всех компонентов системы:
 * - EventBus metrics
 * - MetricsProjector
 * - UserEventsFeedService
 * - Adapters health
 * - OrderRepository state
 *
 * @example
 * ```typescript
 * const diagnostics = new DiagnosticsService(
 *   eventBus,
 *   metricsProjector,
 *   userEventsFeed,
 *   orderRepository,
 *   logger
 * );
 *
 * const health = await diagnostics.getHealth();
 * console.log(`System: ${health.status}`);
 * ```
 */

import type { IDiagnosticsService } from '../../domain/ports/IDiagnosticsService.js';
import type { ILogger } from '../../domain/ports/ILogger.js';
import type { IEventBus } from '../../shared/events/IEventBus.js';
import type { IOrderRepository } from '../../domain/ports/IOrderRepository.js';
import type { MetricsProjector } from '../../application/projectors/MetricsProjector.js';
import type { UserEventsFeedService } from '../exchange/services/UserEventsFeedService.js';
import type {
  SystemHealth,
  DiagnosticsSnapshot,
  ExecutionMetrics,
  StateSnapshot,
  ComponentHealth,
  HealthStatus,
  EventBusMetrics,
  UserEventsFeedStats,
  AdaptersHealth,
} from '../../domain/types/diagnostics.js';

/**
 * DiagnosticsService class
 */
export class DiagnosticsService implements IDiagnosticsService {
  /**
   * Создаёт DiagnosticsService
   *
   * @param eventBus - Event bus для метрик
   * @param metricsProjector - Projector с execution метриками
   * @param userEventsFeed - User events feed service
   * @param orderRepository - Order repository для state
   * @param logger - Logger
   */
  constructor(
    private readonly eventBus: IEventBus,
    private readonly metricsProjector: MetricsProjector,
    private readonly userEventsFeed: UserEventsFeedService,
    private readonly orderRepository: IOrderRepository,
    private readonly logger: ILogger
  ) {}

  /**
   * Получает health status системы
   *
   * @returns System health с проверками компонентов
   */
  public async getHealth(): Promise<SystemHealth> {
    this.logger.debug('[Diagnostics] Collecting health status...');

    const components: ComponentHealth[] = [];

    // Check EventBus
    components.push(this.checkEventBus());

    // Check UserEventsFeed
    components.push(this.checkUserEventsFeed());

    // Check OrderRepository
    components.push(await this.checkOrderRepository());

    // Определяем общий статус системы
    const overallStatus = this.calculateOverallStatus(components);

    const health: SystemHealth = {
      status: overallStatus,
      components,
      timestamp: new Date(),
    };

    this.logger.debug(`[Diagnostics] Health status: ${overallStatus}`);

    return health;
  }

  /**
   * Получает полный diagnostics snapshot
   *
   * @returns Полный снимок диагностики
   */
  public async getDiagnostics(): Promise<DiagnosticsSnapshot> {
    this.logger.debug('[Diagnostics] Collecting full diagnostics snapshot...');

    const [health, executionMetrics, eventBusMetrics, userEventsFeedStats, adaptersHealth, state] =
      await Promise.all([
        this.getHealth(),
        this.getExecutionMetrics(),
        this.getEventBusMetrics(),
        this.getUserEventsFeedStats(),
        this.getAdaptersHealth(),
        this.getStateSnapshot(),
      ]);

    const snapshot: DiagnosticsSnapshot = {
      health,
      executionMetrics,
      eventBusMetrics,
      userEventsFeedStats,
      adaptersHealth,
      state,
      timestamp: new Date(),
    };

    this.logger.debug('[Diagnostics] Diagnostics snapshot collected');

    return snapshot;
  }

  /**
   * Получает execution метрики
   *
   * @returns Execution метрики
   */
  public async getExecutionMetrics(): Promise<ExecutionMetrics> {
    const metrics = this.metricsProjector.getMetrics();

    return {
      ordersPlaced: metrics.ordersPlaced,
      ordersFilled: metrics.ordersFilled,
      ordersRejected: metrics.ordersRejected,
      fillRate: metrics.fillRate,
    };
  }

  /**
   * Получает state snapshot
   *
   * @returns State snapshot
   */
  public async getStateSnapshot(): Promise<StateSnapshot> {
    // Get active orders count
    const allOrders = await this.orderRepository.findAll();
    const activeOrders = allOrders.filter(
      (order) => order.status === 'PENDING' || order.status === 'OPEN'
    ).length;

    // Get user events feed stats
    const feedStats = this.userEventsFeed.getStats();

    const state: StateSnapshot = {
      activeOrders,
      trackedMarkets: 0, // TODO: Add market tracking when implemented
      subscriptions: {
        orderbook: 0, // TODO: Add when ProjectorCoordinator exposes stats
        trades: 0, // TODO: Add when ProjectorCoordinator exposes stats
        userEvents: feedStats.trackedOrdersCount,
      },
      timestamp: new Date(),
    };

    return state;
  }

  /**
   * Проверяет EventBus health
   *
   * @returns ComponentHealth для EventBus
   */
  private checkEventBus(): ComponentHealth {
    try {
      const totalSubscribers = this.eventBus.getAllSubscriberCount();

      return {
        name: 'EventBus',
        status: totalSubscribers > 0 ? 'healthy' : 'degraded',
        message:
          totalSubscribers > 0
            ? `${totalSubscribers} subscribers active`
            : 'No subscribers registered',
        details: {
          totalSubscribers,
        },
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        name: 'EventBus',
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };
    }
  }

  /**
   * Проверяет UserEventsFeed health
   *
   * @returns ComponentHealth для UserEventsFeed
   */
  private checkUserEventsFeed(): ComponentHealth {
    try {
      const stats = this.userEventsFeed.getStats();

      let status: HealthStatus;
      let message: string;

      if (!stats.isStarted) {
        status = 'unhealthy';
        message = 'Service not started';
      } else if (stats.isWebSocketConnected) {
        status = 'healthy';
        message = 'WebSocket connected';
      } else if (stats.isPolling) {
        status = 'degraded';
        message = 'Polling fallback active';
      } else {
        status = 'unhealthy';
        message = 'Neither WebSocket nor polling active';
      }

      return {
        name: 'UserEventsFeed',
        status,
        message,
        details: stats,
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        name: 'UserEventsFeed',
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };
    }
  }

  /**
   * Проверяет OrderRepository health
   *
   * @returns ComponentHealth для OrderRepository
   */
  private async checkOrderRepository(): Promise<ComponentHealth> {
    try {
      const orders = await this.orderRepository.findAll();

      return {
        name: 'OrderRepository',
        status: 'healthy',
        message: `${orders.length} orders in repository`,
        details: {
          totalOrders: orders.length,
        },
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        name: 'OrderRepository',
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };
    }
  }

  /**
   * Вычисляет общий статус системы на основе компонентов
   *
   * @param components - Health checks компонентов
   * @returns Общий статус системы
   *
   * @remarks
   * Логика:
   * - Если хотя бы один компонент unhealthy → система unhealthy
   * - Если все healthy → система healthy
   * - Если есть degraded → система degraded
   */
  private calculateOverallStatus(components: ComponentHealth[]): HealthStatus {
    const hasUnhealthy = components.some((c) => c.status === 'unhealthy');
    const hasDegraded = components.some((c) => c.status === 'degraded');

    if (hasUnhealthy) {
      return 'unhealthy';
    }

    if (hasDegraded) {
      return 'degraded';
    }

    return 'healthy';
  }

  /**
   * Получает EventBus метрики
   *
   * @returns EventBus metrics
   */
  private async getEventBusMetrics(): Promise<EventBusMetrics> {
    const allEventsSubscribers = this.eventBus.getAllSubscriberCount();

    // Get subscribers by event type
    const eventTypes = [
      'OrderPlaced',
      'OrderFilled',
      'OrderCancelled',
      'OrderRejected',
      'OrderUpdated',
      'OrderBookSnapshotReceived',
      'TradeExecuted',
    ];

    const subscribersByEvent: Record<string, number> = {};
    let totalSubscribers = 0;

    for (const eventType of eventTypes) {
      const count = this.eventBus.getSubscriberCount(eventType);
      subscribersByEvent[eventType] = count;
      totalSubscribers += count;
    }

    return {
      totalSubscribers,
      allEventsSubscribers,
      subscribersByEvent,
    };
  }

  /**
   * Получает UserEventsFeed статистику
   *
   * @returns UserEventsFeed stats
   */
  private async getUserEventsFeedStats(): Promise<UserEventsFeedStats> {
    return this.userEventsFeed.getStats();
  }

  /**
   * Получает Adapters health
   *
   * @returns Adapters health status
   */
  private async getAdaptersHealth(): Promise<AdaptersHealth> {
    // NOTE: В будущем можно добавить реальные проверки адаптеров
    // Пока возвращаем stub статус
    return {
      executionAdapter: {
        available: true,
        message: 'Available',
      },
      portfolioAdapter: {
        available: true,
        message: 'Available',
      },
      marketDataFeed: {
        available: true,
        message: 'Available',
      },
    };
  }
}
