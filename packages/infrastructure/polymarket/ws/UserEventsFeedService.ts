/**
 * UserEventsFeedService - обрабатывает user-specific WS order events
 *
 * @remarks
 * Использует WsExecutionMapper + WsExecutionNormalizer для публикации ExecutionEvent
 *
 * Архитектура:
 * ```
 * WS User Events
 *   → WsExecutionMapper (pure parsing) → WsExecutionFact
 *   → WsExecutionNormalizer (aggregate-aware) → ExecutionEvent
 *   → EventEnvelope (ProductionEnvelope)
 *   → EventBus.publish()
 * ```
 *
 * Responsibilities:
 * - Подписка на user-specific WS channel (order updates)
 * - Парсинг WS messages через WsExecutionMapper
 * - Нормализация cumulative → delta через WsExecutionNormalizer
 * - Публикация ExecutionEvent в EventBus
 *
 * @example
 * ```typescript
 * const service = new UserEventsFeedService(
 *   wsManager,
 *   eventBus,
 *   orderRepository,
 *   logger
 * );
 *
 * await service.start();
 * service.trackOrder('order-123'); // Start tracking fills for this order
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { IEventBus } from '../../../shared/events/IEventBus.js';
import type { IOrderRepository } from '../../../domain/ports/IOrderRepository.js';
import type { ExecutionContext } from '../../../domain/execution/ExecutionContext.js';
import type { PolymarketWebSocketManager } from './PolymarketWebSocketManager.js';
import type { WsExecutionMapperMetrics } from '../../ws/WsExecutionMapper.js';
import { WsExecutionNormalizer } from '../../ws/WsExecutionNormalizer.js';

/**
 * Metrics implementation for WsExecutionMapper
 */
class UserEventsFeedMetrics implements WsExecutionMapperMetrics {
  constructor(private readonly logger: ILogger) {}

  increment(counter: 'ws.parse_success' | 'ws.parse_failed' | 'ws.parse_nan'): void {
    this.logger.debug(`[UserEventsFeedMetrics] ${counter}`);
  }

  sample(event: string, data: unknown): void {
    this.logger.debug(`[UserEventsFeedMetrics] ${event}`, data);
  }
}

/**
 * UserEventsFeedService
 *
 * @remarks
 * aggregate-aware normalization для idempotency across restarts
 *
 * NOTE: This is currently a placeholder/stub. Properties initialized in constructor
 * will be used when Polymarket adds user-specific WebSocket feed support.
 */
export class UserEventsFeedService {
  private readonly _wsNormalizer: WsExecutionNormalizer;
  private readonly _metrics: WsExecutionMapperMetrics;
  private readonly _executionContext: ExecutionContext;
  private readonly _eventBus: IEventBus;
  private readonly trackedOrderIds: Set<string> = new Set();

  private isStarted = false;

  constructor(
    _wsManager: PolymarketWebSocketManager,
    eventBus: IEventBus,
    orderRepository: IOrderRepository,
    private readonly logger: ILogger,
    executionContext?: ExecutionContext
  ) {
    this._wsNormalizer = new WsExecutionNormalizer(orderRepository);
    this._metrics = new UserEventsFeedMetrics(logger);
    this._eventBus = eventBus;

    // Default: LIVE environment (production trading)
    this._executionContext = executionContext || {
      environment: 'LIVE',
      accountId: 'default',
    };

    // Suppress unused warnings - these will be used when WS feed is implemented
    void this._wsNormalizer;
    void this._metrics;
    void this._executionContext;
    void this._eventBus;
  }

  /**
   * Start service (подписывается на user WS channel)
   *
   * @remarks
   * TODO: Polymarket API не предоставляет user-specific WS feed (только REST polling).
   * Этот метод placeholder для будущей интеграции с user WS channel.
   *
   * Пока events будут приходить через REST polling (getOrders endpoint).
   */
  public async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.warn('[UserEventsFeedService] Already started');
      return;
    }

    // TODO: Subscribe to user WS channel когда Polymarket добавит user WS feed
    this.logger.info('[UserEventsFeedService] Started (placeholder - no user WS feed yet)');
    this.isStarted = true;
  }

  /**
   * Stop service (отписывается от user WS channel)
   */
  public async stop(): Promise<void> {
    if (!this.isStarted) {
      this.logger.warn('[UserEventsFeedService] Not started');
      return;
    }

    // TODO: Unsubscribe from user WS channel
    this.logger.info('[UserEventsFeedService] Stopped');
    this.isStarted = false;
  }

  /**
   * Track order (start listening for fills/cancels for this order)
   *
   * @param orderId - Order ID to track
   *
   * @remarks
   * Добавляет orderId в tracked set.
   * Только tracked orders публикуют события в EventBus.
   */
  public trackOrder(orderId: string): void {
    this.trackedOrderIds.add(orderId);
    this.logger.debug(`[UserEventsFeedService] Tracking order ${orderId}`);
  }

  /**
   * Untrack order (stop listening for this order)
   *
   * @param orderId - Order ID to untrack
   */
  public untrackOrder(orderId: string): void {
    this.trackedOrderIds.delete(orderId);
    this.logger.debug(`[UserEventsFeedService] Untracked order ${orderId}`);
  }


  /**
   * Get stats (for diagnostics)
   *
   * @returns Stats object
   */
  public getStats(): {
    isStarted: boolean;
    trackedOrderCount: number;
  } {
    return {
      isStarted: this.isStarted,
      trackedOrderCount: this.trackedOrderIds.size,
    };
  }
}
