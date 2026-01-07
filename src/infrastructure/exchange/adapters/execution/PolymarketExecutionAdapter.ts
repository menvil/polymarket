/**
 * PolymarketExecutionAdapter - реализация IExecutionAdapter
 *
 * @remarks
 * Адаптер для execution операций (размещение/отмена ордеров) через Polymarket CLOB.
 * Часть разделения PolymarketRestAdapter на Execution и Portfolio (Step 3).
 *
 * Responsibilities:
 * - Размещение ордеров с нормализацией и валидацией (через policies)
 * - Отмена ордеров
 * - Получение открытых ордеров
 * - Подписка на обновления ордеров (WebSocket)
 * - Обучение из ошибок API (learnFromError)
 *
 * Использует:
 * - CLOBClient для execution operations
 * - MarketConstraintsPolicy для нормализации размера и обучения
 * - BalancePolicy для проверки баланса
 * - WebSocketManager для подписок на order updates
 *
 * @example
 * ```typescript
 * const executionAdapter = new PolymarketExecutionAdapter(
 *   clobClient,
 *   marketConstraintsPolicy,
 *   balancePolicy,
 *   wsManager,
 *   logger
 * );
 *
 * // Place order with normalization and validation
 * const order = Order.create({...});
 * const placedOrder = await executionAdapter.placeOrder(order);
 * ```
 */

import { IExecutionAdapter } from '../../../../domain/ports/IExecutionAdapter.js';
import { Order } from '../../../../domain/entities/Order.js';
import { Quantity } from '../../../../domain/value-objects/Quantity.js';
import { ExchangeError } from '../../../../shared/errors/TradingError.js';
import { ILogger } from '../../../../domain/ports/ILogger.js';
import { CLOBClient } from '../../clients/CLOBClient.js';
import { OrderMapper } from '../../mappers/OrderMapper.js';
import { MarketConstraintsPolicy } from '../../policies/MarketConstraintsPolicy.js';
import { BalancePolicy } from '../../policies/BalancePolicy.js';
import type { IEventBus } from '../../../../shared/events/IEventBus.js';
import { OrderPlacedEvent } from '../../../../domain/events/OrderPlacedEvent.js';
import { OrderCancelledEvent } from '../../../../domain/events/OrderCancelledEvent.js';
import { OrderRejectedEvent } from '../../../../domain/events/OrderRejectedEvent.js';
import type { UserEventsFeedService } from '../../services/UserEventsFeedService.js';

/**
 * Polymarket Execution Adapter
 *
 * @remarks
 * Реализация IExecutionAdapter для Polymarket CLOB.
 * Использует execution policies для валидации перед размещением ордеров.
 */
export class PolymarketExecutionAdapter implements IExecutionAdapter {
  /**
   * Создаёт Polymarket Execution Adapter
   *
   * @param clobClient - CLOB REST API клиент
   * @param marketConstraintsPolicy - Политика market constraints
   * @param balancePolicy - Политика проверки баланса
   * @param eventBus - Event bus для публикации событий (Step 4)
   * @param userEventsFeed - User events feed service (Step 5)
   * @param logger - Логгер
   */
  constructor(
    private readonly clobClient: CLOBClient,
    private readonly marketConstraintsPolicy: MarketConstraintsPolicy,
    private readonly balancePolicy: BalancePolicy,
    private readonly eventBus: IEventBus,
    private readonly userEventsFeed: UserEventsFeedService,
    private readonly logger: ILogger
  ) {}

  /**
   * Размещает ордер с нормализацией и валидацией
   *
   * @param order - Domain Order для размещения
   * @returns Размещённый ордер с обновлённым статусом
   * @throws {ExchangeError} При ошибке API
   * @throws {Error} При insufficient balance или invalid size
   *
   * @remarks
   * Алгоритм (полный flow с policies):
   * 1. Нормализует размер через MarketConstraintsPolicy
   *    - Округляет по sizeTick
   *    - Проверяет min/max constraints
   * 2. Проверяет баланс через BalancePolicy
   *    - BUY: проверяет USDC (cost = size * price)
   *    - SELL: проверяет outcome tokens (size)
   * 3. Конвертирует Domain Order → API params
   * 4. Вызывает CLOBClient.placeOrder()
   * 5. Конвертирует API response → Domain Order
   * 6. Обучается из ошибок (learnFromError)
   *
   * @example
   * ```typescript
   * const order = Order.create({
   *   tokenId: '0xabc',
   *   side: 'BUY',
   *   price: Price.fromNumber(0.55),
   *   size: Quantity.fromNumber(100.567), // will be normalized to 100.57
   *   status: 'PENDING'
   * });
   *
   * try {
   *   const placedOrder = await executionAdapter.placeOrder(order);
   *   console.log(`Placed: ${placedOrder.id}, size: ${placedOrder.size.value}`);
   * } catch (error) {
   *   console.error('Failed to place order:', error.message);
   * }
   * ```
   */
  public async placeOrder(order: Order): Promise<Order> {
    try {
      this.logger.info(`[ExecutionAdapter] Placing order: ${order.toString()}`);

      // Step 1: Normalize size via MarketConstraintsPolicy
      const normalizationResult = await this.marketConstraintsPolicy.normalizeSize(
        order.tokenId,
        order.size.value
      );

      if (normalizationResult.wasNormalized) {
        this.logger.debug(
          `[ExecutionAdapter] Size normalized: ${normalizationResult.originalSize} → ${normalizationResult.normalizedSize} (${normalizationResult.reason})`
        );
      }

      // Create order with normalized size
      const normalizedOrder = Order.create({
        id: order.id,
        tokenId: order.tokenId,
        side: order.side,
        price: order.price,
        size: Quantity.fromNumber(normalizationResult.normalizedSize),
        status: order.status,
        timestamp: order.timestamp,
        filledSize: order.filledSize,
        averageFillPrice: order.averageFillPrice,
      });

      // Step 2: Check balance via BalancePolicy
      // NOTE: В Step 6 будет реальный баланс от BalanceRestClient
      // Пока используем placeholder для демонстрации
      const availableBalance = 1000; // TODO: fetch from BalanceRestClient

      const balanceCheck = this.balancePolicy.checkBalance(normalizedOrder, availableBalance);

      if (!balanceCheck.isValid) {
        this.logger.warn(
          `[ExecutionAdapter] Insufficient balance: ${balanceCheck.reason}`
        );
        throw new Error(balanceCheck.reason);
      }

      this.logger.debug(
        `[ExecutionAdapter] Balance check passed: required ${balanceCheck.required.toFixed(2)}, available ${balanceCheck.available.toFixed(2)}`
      );

      // Step 3: Convert Domain Order → API params
      const apiParams = OrderMapper.toApi(normalizedOrder);

      // Step 4: Call CLOB API
      this.logger.debug(`[ExecutionAdapter] Sending order to CLOB API...`);
      const response = await this.clobClient.placeOrder(apiParams);

      // Step 5: Convert API response → Domain Order
      const placedOrder = OrderMapper.fromPlaceOrderResponse(response);

      this.logger.info(`[ExecutionAdapter] Order placed successfully: ${placedOrder.id}`);

      // Step 6: Publish OrderPlacedEvent (Step 4: Event-driven)
      const event = new OrderPlacedEvent(placedOrder);
      this.eventBus.publish(event);
      this.logger.debug(`[ExecutionAdapter] Published OrderPlacedEvent for ${placedOrder.id}`);

      return placedOrder;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[ExecutionAdapter] Failed to place order: ${message}`);

      // Step 7: Learn from errors
      if (this.isConstraintError(error)) {
        this.logger.debug(`[ExecutionAdapter] Learning from constraint error...`);
        this.marketConstraintsPolicy.learnFromError(order.tokenId, message);
      }

      // Step 8: Publish OrderRejectedEvent (Step 4: Event-driven)
      const rejectedEvent = new OrderRejectedEvent(
        order.id,
        message,
        this.extractErrorCode(error)
      );
      this.eventBus.publish(rejectedEvent);
      this.logger.debug(`[ExecutionAdapter] Published OrderRejectedEvent for ${order.id}`);

      throw new ExchangeError(`Failed to place order: ${message}`);
    }
  }

  /**
   * Отменяет ордер
   *
   * @param orderId - ID ордера для отмены
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * - Отправляет запрос на отмену в CLOB
   * - Асинхронная операция (подтверждение может прийти через WebSocket)
   * - Только PENDING или OPEN ордера могут быть отменены
   */
  public async cancelOrder(orderId: string): Promise<void> {
    try {
      this.logger.info(`[ExecutionAdapter] Canceling order: ${orderId}`);

      await this.clobClient.cancelOrder({ orderId });

      this.logger.info(`[ExecutionAdapter] Cancel request sent for order: ${orderId}`);

      // Publish OrderCancelledEvent (Step 4: Event-driven)
      const event = new OrderCancelledEvent(orderId, 'User requested');
      this.eventBus.publish(event);
      this.logger.debug(`[ExecutionAdapter] Published OrderCancelledEvent for ${orderId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[ExecutionAdapter] Failed to cancel order ${orderId}: ${message}`);
      throw new ExchangeError(`Failed to cancel order: ${message}`);
    }
  }

  /**
   * Получает все открытые ордера
   *
   * @param tokenId - Опциональный фильтр по tokenId
   * @returns Массив открытых ордеров
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * - Возвращает только PENDING и OPEN ордера
   * - Если tokenId указан → фильтрует только по этому токену
   * - Использует CLOBClient.getOrders() для REST API запроса
   *
   * @example
   * ```typescript
   * // Все открытые ордера
   * const allOrders = await adapter.getOpenOrders();
   *
   * // Ордера для конкретного токена
   * const tokenOrders = await adapter.getOpenOrders('0x123...');
   * ```
   */
  public async getOpenOrders(tokenId?: string): Promise<Order[]> {
    try {
      this.logger.debug(
        `[ExecutionAdapter] Fetching open orders${tokenId ? ` for token ${tokenId.substring(0, 16)}...` : '...'}`
      );

      // Fetch orders from CLOB API
      const apiOrders = await this.clobClient.getOrders(tokenId);

      // Map API responses to Domain Order entities
      const orders = apiOrders.map((apiOrder) => OrderMapper.fromPlaceOrderResponse(apiOrder));

      this.logger.debug(`[ExecutionAdapter] Found ${orders.length} open orders`);

      return orders;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[ExecutionAdapter] Failed to fetch open orders: ${message}`);
      throw new ExchangeError(`Failed to fetch open orders: ${message}`);
    }
  }

  /**
   * Подписывается на обновления ордера
   *
   * @param orderId - ID ордера
   * @param callback - Функция обратного вызова при обновлении
   * @returns Функция для отписки
   *
   * @remarks
   * - Делегирует UserEventsFeedService для WebSocket/polling
   * - Callback вызывается при каждом изменении статуса ордера
   * - Автоматически публикует domain events в EventBus
   * - Возвращает unsubscribe функцию для отписки
   *
   * @example
   * ```typescript
   * const unsubscribe = adapter.subscribeToOrderUpdates('0xabc...', (order) => {
   *   console.log(`Order ${order.id} status: ${order.status}`);
   * });
   *
   * // Отписаться
   * unsubscribe();
   * ```
   */
  public subscribeToOrderUpdates(
    orderId: string,
    callback: (order: Order) => void
  ): () => void {
    this.logger.debug(`[ExecutionAdapter] Subscribing to order updates: ${orderId}`);

    // Subscribe to EventBus for OrderFilledEvent and OrderUpdatedEvent
    const handleOrderFilled = (event: unknown): void => {
      const orderFilledEvent = event as { order: Order };
      if (orderFilledEvent.order.id === orderId) {
        callback(orderFilledEvent.order);
      }
    };

    const handleOrderUpdated = (event: unknown): void => {
      const orderUpdatedEvent = event as { order: Order };
      if (orderUpdatedEvent.order.id === orderId) {
        callback(orderUpdatedEvent.order);
      }
    };

    const handleOrderCancelled = (event: unknown): void => {
      const orderCancelledEvent = event as { orderId: string };
      if (orderCancelledEvent.orderId === orderId) {
        // Fetch order details to pass to callback
        this.getOpenOrders()
          .then((orders) => {
            const order = orders.find((o) => o.id === orderId);
            if (order) {
              callback(order);
            }
          })
          .catch((error) => {
            this.logger.error(`[ExecutionAdapter] Failed to fetch order after cancel`, error);
          });
      }
    };

    // Subscribe to EventBus
    const unsubscribeFilled = this.eventBus.subscribe('OrderFilled', handleOrderFilled);
    const unsubscribeUpdated = this.eventBus.subscribe('OrderUpdated', handleOrderUpdated);
    const unsubscribeCancelled = this.eventBus.subscribe('OrderCancelled', handleOrderCancelled);

    // Subscribe to UserEventsFeedService
    const unsubscribeFeed = this.userEventsFeed.subscribeToOrder(orderId);

    // Return combined unsubscribe function
    return () => {
      this.logger.debug(`[ExecutionAdapter] Unsubscribing from order updates: ${orderId}`);
      unsubscribeFilled();
      unsubscribeUpdated();
      unsubscribeCancelled();
      unsubscribeFeed();
    };
  }

  /**
   * Извлекает error code из ошибки
   *
   * @param error - Ошибка
   * @returns Error code или undefined
   *
   * @remarks
   * Пытается извлечь код ошибки из известных форматов.
   */
  private extractErrorCode(error: unknown): string | undefined {
    if (!(error instanceof Error)) {
      return undefined;
    }

    const message = error.message.toLowerCase();
    if (message.includes('insufficient') && message.includes('balance')) {
      return 'INSUFFICIENT_BALANCE';
    }
    if (message.includes('min') || message.includes('max') || message.includes('tick')) {
      return 'CONSTRAINTS_VIOLATION';
    }
    return undefined;
  }

  /**
   * Проверяет, является ли ошибка constraint error
   *
   * @param error - Ошибка
   * @returns true если это constraint error
   *
   * @remarks
   * Constraint errors содержат информацию о minOrderSize, sizeTick, maxOrderSize.
   * Парсим их через MarketConstraintsPolicy.learnFromError().
   *
   * Примеры:
   * - "size 5.5 is lower than min 10"
   * - "size X below minimum Y"
   * - "order size must be at least X"
   */
  private isConstraintError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes('min') ||
      message.includes('minimum') ||
      message.includes('at least') ||
      message.includes('size') ||
      message.includes('tick')
    );
  }
}
