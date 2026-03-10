/**
 * UserEventsFeedService — обрабатывает user-specific WS order events
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
 * Обязанности:
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

import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '../ports/IEventBus.js';
import type { IInfraOrderRepository as IOrderRepository } from '../ports/IInfraOrderRepository.js';
import type { ExecutionContext } from '../events/ExecutionContext.js';
import type { PolymarketWebSocketManager } from './PolymarketWebSocketManager.js';
import type { WsExecutionMapperMetrics } from './WsExecutionMapper.js';
import { WsExecutionNormalizer } from './WsExecutionNormalizer.js';

/**
 * Реализация метрик для WsExecutionMapper
 */
class UserEventsFeedMetrics implements WsExecutionMapperMetrics {
  constructor(private readonly logger: ILogger) {}

  increment(counter: 'ws.parse_success' | 'ws.parse_failed' | 'ws.parse_nan'): void {
    this.logger.debug(`[UserEventsFeedMetrics] ${counter}`);
  }

  sample(event: string, data: unknown): void {
    this.logger.debug(`[UserEventsFeedMetrics] ${event}`, data as Record<string, unknown> | undefined);
  }
}

/**
 * UserEventsFeedService
 *
 * @remarks
 * aggregate-aware normalization для idempotency across restarts
 *
 * ПРИМЕЧАНИЕ: Это в настоящее время placeholder/stub. Свойства, инициализированные в конструкторе,
 * будут использованы когда Polymarket добавит поддержку user-specific WebSocket feed.
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

    // По умолчанию: LIVE окружение (реальная торговля)
    this._executionContext = executionContext || {
      environment: 'LIVE',
      accountId: 'default',
    };

    // Подавляем предупреждения об неиспользуемых переменных — будут использованы при реализации WS feed
    void this._wsNormalizer;
    void this._metrics;
    void this._executionContext;
    void this._eventBus;
  }

  /**
   * Запускает сервис (подписывается на user WS channel)
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

    // TODO: Подписаться на user WS channel когда Polymarket добавит user WS feed
    this.logger.info('[UserEventsFeedService] Started (placeholder - no user WS feed yet)');
    this.isStarted = true;
  }

  /**
   * Останавливает сервис (отписывается от user WS channel)
   */
  public async stop(): Promise<void> {
    if (!this.isStarted) {
      this.logger.warn('[UserEventsFeedService] Not started');
      return;
    }

    // TODO: Отписаться от user WS channel
    this.logger.info('[UserEventsFeedService] Stopped');
    this.isStarted = false;
  }

  /**
   * Начинает отслеживание ордера (ожидание fills/cancels для него)
   *
   * @param orderId - ID ордера для отслеживания
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
   * Прекращает отслеживание ордера
   *
   * @param orderId - ID ордера для снятия с отслеживания
   */
  public untrackOrder(orderId: string): void {
    this.trackedOrderIds.delete(orderId);
    this.logger.debug(`[UserEventsFeedService] Untracked order ${orderId}`);
  }


  /**
   * Возвращает статистику (для диагностики)
   *
   * @returns Объект со статистикой
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
