/**
 * UserEventsFeedService - сервис для получения user events (fills, order updates)
 *
 * @remarks
 * Управляет подписками на user events через WebSocket с polling fallback.
 *
 * Architecture:
 * - Primary channel: WebSocket (wss://ws-subscriptions-clob.polymarket.com/ws/user)
 * - Fallback: Polling (REST API GET /orders) при WebSocket disconnect
 * - Публикует domain events (OrderFilledEvent, OrderUpdatedEvent, OrderCancelledEvent)
 *
 * Lifecycle:
 * 1. start() - подключается к WebSocket user events feed
 * 2. subscribeToOrder(orderId) - начинает отслеживать ордер
 * 3. При получении update → маппинг → публикация domain event
 * 4. При disconnect → автоматический переход на polling
 * 5. При reconnect → восстановление WebSocket, остановка polling
 * 6. stop() - отключение от WebSocket, остановка polling
 *
 * @example
 * ```typescript
 * const service = new UserEventsFeedService(wsManager, clobClient, eventBus, logger);
 * await service.start();
 *
 * // Подписываемся на обновления ордера
 * const unsubscribe = service.subscribeToOrder('0xabc...');
 *
 * // События автоматически публикуются в EventBus:
 * // - OrderFilledEvent при исполнении
 * // - OrderUpdatedEvent при изменении статуса
 * // - OrderCancelledEvent при отмене
 *
 * // Отписываемся
 * unsubscribe();
 *
 * await service.stop();
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { IEventBus } from '../../../shared/events/IEventBus.js';
import type { CLOBClient } from '../clients/CLOBClient.js';
import type { WebSocketManager } from '../clients/WebSocketManager.js';
import { UserEventsMapper } from '../mappers/UserEventsMapper.js';

/**
 * UserEventsFeedService class
 */
export class UserEventsFeedService {
  private isStarted = false;
  private isWebSocketConnected = false;
  private pollingIntervalId: NodeJS.Timeout | null = null;
  private readonly pollingIntervalMs = 5000; // 5 seconds
  private readonly trackedOrderIds = new Set<string>();
  private readonly lastOrderStates = new Map<string, string>(); // orderId → status

  /**
   * Создаёт UserEventsFeedService
   *
   * @param wsManager - WebSocket manager для user events
   * @param clobClient - CLOB client для polling fallback
   * @param eventBus - Event bus для публикации domain events
   * @param logger - Logger
   */
  constructor(
    private readonly wsManager: WebSocketManager,
    // @ts-expect-error - Will be used in pollOrders() when fully implemented
    private readonly clobClient: CLOBClient,
    private readonly eventBus: IEventBus,
    private readonly logger: ILogger
  ) {}

  /**
   * Запускает user events feed
   *
   * @remarks
   * - Подключается к WebSocket user events
   * - Подписывается на WebSocket events (message, connected, disconnected)
   * - При disconnect автоматически запускает polling
   * - При reconnect останавливает polling
   *
   * @throws {Error} Если сервис уже запущен
   */
  public async start(): Promise<void> {
    if (this.isStarted) {
      throw new Error('UserEventsFeedService is already started');
    }

    this.logger.info('[UserEventsFeed] Starting...');

    // Subscribe to WebSocket events
    this.wsManager.on('message', this.handleWebSocketMessage.bind(this));
    this.wsManager.on('connected', this.handleWebSocketConnected.bind(this));
    this.wsManager.on('disconnected', this.handleWebSocketDisconnected.bind(this));

    // Connect to WebSocket user events
    try {
      await this.wsManager.connect();
      this.isWebSocketConnected = true;
      this.logger.info('[UserEventsFeed] WebSocket connected');
    } catch (error) {
      this.logger.warn('[UserEventsFeed] WebSocket connection failed, using polling', error);
      this.isWebSocketConnected = false;
      this.startPolling();
    }

    this.isStarted = true;
    this.logger.info('[UserEventsFeed] Started');
  }

  /**
   * Останавливает user events feed
   *
   * @remarks
   * - Отключается от WebSocket
   * - Останавливает polling
   * - Очищает все подписки
   */
  public async stop(): Promise<void> {
    if (!this.isStarted) {
      return;
    }

    this.logger.info('[UserEventsFeed] Stopping...');

    // Stop polling
    this.stopPolling();

    // Disconnect WebSocket
    try {
      await this.wsManager.disconnect();
    } catch (error) {
      this.logger.warn('[UserEventsFeed] WebSocket disconnect failed', error);
    }

    // Clear state
    this.trackedOrderIds.clear();
    this.lastOrderStates.clear();
    this.isWebSocketConnected = false;
    this.isStarted = false;

    this.logger.info('[UserEventsFeed] Stopped');
  }

  /**
   * Подписывается на обновления ордера
   *
   * @param orderId - ID ордера для отслеживания
   * @returns Функция для отписки
   *
   * @remarks
   * Добавляет ордер в список отслеживаемых.
   * События автоматически публикуются в EventBus при получении updates.
   *
   * @throws {Error} Если сервис не запущен
   */
  public subscribeToOrder(orderId: string): () => void {
    if (!this.isStarted) {
      throw new Error('UserEventsFeedService is not started');
    }

    this.trackedOrderIds.add(orderId);
    this.logger.debug(`[UserEventsFeed] Subscribed to order: ${orderId}`);

    // Return unsubscribe function
    return () => {
      this.trackedOrderIds.delete(orderId);
      this.lastOrderStates.delete(orderId);
      this.logger.debug(`[UserEventsFeed] Unsubscribed from order: ${orderId}`);
    };
  }

  /**
   * Обрабатывает WebSocket message
   *
   * @param data - Raw WebSocket data (Buffer or string)
   *
   * @remarks
   * 1. Парсит message через UserEventsMapper
   * 2. Проверяет, отслеживается ли ордер
   * 3. Публикует domain event в EventBus
   */
  private handleWebSocketMessage(data: Buffer | string): void {
    try {
      const message = data.toString();

      // Map to domain event
      const event = UserEventsMapper.fromWebSocketMessage(message);

      if (!event) {
        return; // Not a user event or invalid message
      }

      // Extract orderId from event
      const orderId = this.extractOrderIdFromEvent(event);
      if (!orderId) {
        return;
      }

      // Check if we're tracking this order
      if (!this.trackedOrderIds.has(orderId)) {
        return;
      }

      // Publish domain event
      this.eventBus.publish(event);
      this.logger.debug(`[UserEventsFeed] Published ${event.eventName} for order ${orderId}`);
    } catch (error) {
      this.logger.error('[UserEventsFeed] Failed to handle WebSocket message', error);
    }
  }

  /**
   * Обрабатывает WebSocket connected event
   */
  private handleWebSocketConnected(): void {
    this.isWebSocketConnected = true;
    this.logger.info('[UserEventsFeed] WebSocket reconnected');

    // Stop polling (WebSocket is primary channel)
    this.stopPolling();
  }

  /**
   * Обрабатывает WebSocket disconnected event
   */
  private handleWebSocketDisconnected(): void {
    this.isWebSocketConnected = false;
    this.logger.warn('[UserEventsFeed] WebSocket disconnected, switching to polling');

    // Start polling as fallback
    this.startPolling();
  }

  /**
   * Запускает polling fallback
   *
   * @remarks
   * Периодически запрашивает список открытых ордеров через REST API.
   * Сравнивает с предыдущим состоянием и публикует domain events при изменениях.
   */
  private startPolling(): void {
    if (this.pollingIntervalId) {
      return; // Already polling
    }

    this.logger.info('[UserEventsFeed] Starting polling fallback');

    // Poll immediately
    this.pollOrders().catch((error) => {
      this.logger.error('[UserEventsFeed] Polling failed', error);
    });

    // Then poll periodically
    this.pollingIntervalId = setInterval(() => {
      this.pollOrders().catch((error) => {
        this.logger.error('[UserEventsFeed] Polling failed', error);
      });
    }, this.pollingIntervalMs);
  }

  /**
   * Останавливает polling
   */
  private stopPolling(): void {
    if (this.pollingIntervalId) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
      this.logger.info('[UserEventsFeed] Stopped polling');
    }
  }

  /**
   * Опрашивает ордера через REST API
   *
   * @remarks
   * 1. Запрашивает все открытые ордера через CLOB API
   * 2. Фильтрует только отслеживаемые ордера
   * 3. Сравнивает с предыдущим состоянием
   * 4. Публикует domain events при изменениях
   */
  private async pollOrders(): Promise<void> {
    try {
      // NOTE: В реальной реализации нужно использовать CLOBClient.getOrders()
      // Пока оставляем stub (будет реализовано в getOpenOrders())
      this.logger.silly('[UserEventsFeed] Polling orders (stub)');

      // TODO: Реализовать после добавления CLOBClient.getOrders()
      // const orders = await this.clobClient.getOrders();
      // for (const order of orders) {
      //   if (this.trackedOrderIds.has(order.id)) {
      //     this.checkOrderStateChange(order);
      //   }
      // }
    } catch (error) {
      this.logger.error('[UserEventsFeed] Failed to poll orders', error);
    }
  }

  /**
   * Извлекает orderId из domain event
   *
   * @param event - Domain event
   * @returns Order ID или null
   */
  private extractOrderIdFromEvent(event: unknown): string | null {
    if (event && typeof event === 'object' && 'order' in event) {
      const order = (event as { order: { id: string } }).order;
      return order?.id || null;
    }

    if (event && typeof event === 'object' && 'orderId' in event) {
      return (event as { orderId: string }).orderId || null;
    }

    return null;
  }

  /**
   * Возвращает статистику сервиса
   *
   * @returns Статистика
   */
  public getStats(): {
    isStarted: boolean;
    isWebSocketConnected: boolean;
    isPolling: boolean;
    trackedOrdersCount: number;
  } {
    return {
      isStarted: this.isStarted,
      isWebSocketConnected: this.isWebSocketConnected,
      isPolling: this.pollingIntervalId !== null,
      trackedOrdersCount: this.trackedOrderIds.size,
    };
  }
}
