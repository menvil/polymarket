/**
 * UserEventsFeedService - обрабатывает user-specific WS события ордеров
 *
 * @remarks
 * Использует WsExecutionMapper + WsExecutionNormalizer для публикации ExecutionEvent
 *
 * Архитектура:
 * ```
 * WS User Events
 *   → WsExecutionMapper (чистый парсинг) → WsExecutionFact
 *   → WsExecutionNormalizer (aggregate-aware) → ExecutionEvent
 *   → EventEnvelope (ProductionEnvelope)
 *   → EventBus.publish()
 * ```
 *
 * Обязанности:
 * - Подписка на user-specific WS канал (обновления ордеров)
 * - Парсинг WS сообщений через WsExecutionMapper
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
 * service.trackOrder('order-123'); // Начать отслеживание исполнений для этого ордера
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
 * Реализация метрик для WsExecutionMapper
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
 * aggregate-aware нормализация для idempotency при перезапусках
 *
 * ПРИМЕЧАНИЕ: Это в настоящее время заглушка/placeholder. Свойства инициализированные в конструкторе
 * будут использованы когда Polymarket добавит поддержку user-specific WebSocket фида.
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

    // По умолчанию: LIVE окружение (продакшен торговля)
    this._executionContext = executionContext || {
      environment: 'LIVE',
      accountId: 'default',
    };

    // Подавляем предупреждения о неиспользуемых переменных - они будут использованы когда WS фид будет реализован
    void this._wsNormalizer;
    void this._metrics;
    void this._executionContext;
    void this._eventBus;
  }

  /**
   * Запускает сервис (подписывается на user WS канал)
   *
   * @remarks
   * TODO: Polymarket API не предоставляет user-specific WS фид (только REST polling).
   * Этот метод заглушка для будущей интеграции с user WS каналом.
   *
   * Пока события будут приходить через REST polling (getOrders endpoint).
   */
  public async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.warn('[UserEventsFeedService] Already started');
      return;
    }

    // TODO: Подписаться на user WS канал когда Polymarket добавит user WS фид
    this.logger.info('[UserEventsFeedService] Started (placeholder - no user WS feed yet)');
    this.isStarted = true;
  }

  /**
   * Останавливает сервис (отписывается от user WS канала)
   */
  public async stop(): Promise<void> {
    if (!this.isStarted) {
      this.logger.warn('[UserEventsFeedService] Not started');
      return;
    }

    // TODO: Отписаться от user WS канала
    this.logger.info('[UserEventsFeedService] Stopped');
    this.isStarted = false;
  }

  /**
   * Отслеживает ордер (начинает слушать исполнения/отмены для этого ордера)
   *
   * @param orderId - ID ордера для отслеживания
   *
   * @remarks
   * Добавляет orderId в tracked set.
   * Только отслеживаемые ордера публикуют события в EventBus.
   */
  public trackOrder(orderId: string): void {
    this.trackedOrderIds.add(orderId);
    this.logger.debug(`[UserEventsFeedService] Tracking order ${orderId}`);
  }

  /**
   * Прекращает отслеживание ордера (перестает слушать этот ордер)
   *
   * @param orderId - ID ордера для прекращения отслеживания
   */
  public untrackOrder(orderId: string): void {
    this.trackedOrderIds.delete(orderId);
    this.logger.debug(`[UserEventsFeedService] Untracked order ${orderId}`);
  }


  /**
   * Получает статистику (для диагностики)
   *
   * @returns Объект статистики
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
