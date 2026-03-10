/**
 * Polymarket Execution Adapter
 *
 * @remarks
 * ONLY API calls + event publishing, NO validation, NO balance checks.
 * Implements IExecutionAdapter.
 *
 * Key principle: **Separation of Concerns**
 * - Validation → BalancePolicy, MarketConstraintsPolicy
 * - API calls → ExecutionAdapter (this class)
 * - Event publishing → ExecutionAdapter (после API calls)
 * - Orchestration → RestAdapter (Facade)
 *
 * This adapter assumes all parameters are already validated and normalized
 * by policies BEFORE being passed here.
 *
 * После API call публикует ExecutionEvent в EventBus
 * - postOrder success → OrderAccepted (с minimal context)
 * - postOrder error → OrderRejected (ExecutionErrorEvent)
 * - cancelOrder success → OrderCancelled
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketExecutionAdapter(
 *   orderClient,
 *   mapper,
 *   eventBus,
 *   logger
 * );
 *
 * // Parameters are already normalized and validated!
 * const order = await adapter.postOrder({
 *   tokenId: '0x123',
 *   side: 'buy',
 *   price: 0.52,
 *   size: 100, // Already rounded to sizeTick
 * });
 *
 * // ExecutionAdapter published OrderAccepted event internally
 * console.log(`Order placed: ${order.orderId}`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type {
  IExecutionAdapter,
  PlaceOrderParams,
  OrderResponse,
  FillResponse,
} from '../../ports/IExecutionAdapter.js';
import type { PolymarketOrderRestClient } from '../clients/PolymarketOrderRestClient.js';
import type { PolymarketOrderMapper } from '../mappers/PolymarketOrderMapper.js';
import type { IEventBus } from '../../ports/IEventBus.js';
import type {
  OrderAccepted,
  OrderCancelled,
  OrderRejected,
} from '../../events/ExecutionEvent.js';
import type { ExecutionContext } from '../../events/ExecutionContext.js';
import { createProductionEnvelope } from '../../events/EventEnvelope.js';

/**
 * Polymarket Execution Adapter
 *
 * @remarks
 * ONLY API calls + event publishing - no business validation!
 *
 * Публикует ExecutionEvent в EventBus после каждого API call
 */
export class PolymarketExecutionAdapter implements IExecutionAdapter {
  /**
   * ExecutionContext для всех событий (LIVE environment)
   */
  private readonly executionContext: ExecutionContext;

  constructor(
    private readonly orderClient: PolymarketOrderRestClient,
    private readonly mapper: PolymarketOrderMapper,
    private readonly eventBus: IEventBus,
    private readonly logger: ILogger,
    executionContext?: ExecutionContext,
    private readonly simulationMode: boolean = false
  ) {
    // По умолчанию: LIVE окружение (реальная торговля)
    this.executionContext = executionContext || {
      environment: 'LIVE',
      accountId: 'default',
    };
  }

  /**
   * Place order (ONLY API call + event publishing, NO validation)
   *
   * @param params - Normalized order parameters (already validated!)
   * @returns Order response
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Assumes:
   * - Size is already normalized (rounded to sizeTick)
   * - Balance is already checked
   * - Price is valid
   *
   * После успешного API call публикует OrderAccepted event
   * При ошибке публикует OrderRejected event (ExecutionErrorEvent)
   *
   * @example
   * ```typescript
   * const order = await adapter.postOrder({
   *   tokenId: '0x123',
   *   side: 'buy',
   *   price: 0.52,
   *   size: 100,
   * });
   * // OrderAccepted event published internally
   * ```
   */
  async postOrder(params: PlaceOrderParams): Promise<OrderResponse> {
    // РЕЖИМ СИМУЛЯЦИИ: Пропускаем API вызов, возвращаем виртуальный ордер
    if (this.simulationMode) {
      const virtualOrderId = `sim-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      this.logger.info('Placing order (SIMULATION MODE - virtual order)', {
        tokenId: params.tokenId,
        side: params.side,
        price: params.price,
        size: params.size,

        virtualOrderId,
      });

      const virtualOrder: OrderResponse = {
        orderId: virtualOrderId,
        status: 'open',
        side: params.side,
        price: params.price,
        size: params.size,
        sizeRemaining: params.size,
        tokenId: params.tokenId,
        createdAt: Date.now(),
      };

      // Публикуем событие OrderAccepted
      const orderAcceptedEvent: OrderAccepted = {
        type: 'OrderAccepted',
        orderId: virtualOrder.orderId,
        strategyId: params.strategyId,
        side: params.side.toUpperCase() as 'BUY' | 'SELL',
        marketId: params.tokenId,
        price: params.price,
        size: params.size,
        timestamp: new Date(),
      };

      const envelope = createProductionEnvelope(orderAcceptedEvent, this.executionContext);
      this.eventBus.publish(envelope);

      this.logger.debug('Published OrderAccepted event (SIMULATION MODE)', {
        orderId: virtualOrder.orderId,
        strategyId: params.strategyId,
      });

      return virtualOrder;
    }

    // БОЕВОЙ РЕЖИМ: Реальный API вызов
    this.logger.info('Placing order via API', {
      tokenId: params.tokenId,
      side: params.side,
      price: params.price,
      size: params.size,
      priceTick: params.priceTick,
    });

    try {
      // Конвертируем параметры домена в формат API
      const apiRequest = this.mapper.toApiRequest({
        tokenId: params.tokenId,
        side: params.side,
        price: params.price,
        size: params.size,
        priceTick: params.priceTick,
        feeRateBps: params.feeRateBps, // Используем изученную или дефолтную ставку комиссии
      });

      // Выполняем API вызов
      const apiResponse = await this.orderClient.createOrder(apiRequest);

      // Конвертируем ответ API в формат домена
      const domainOrder = this.mapper.toDomainOrder(apiResponse);

      this.logger.info('Order placed successfully', {
        orderId: domainOrder.orderId,
        status: domainOrder.status,
        sizeRemaining: domainOrder.sizeRemaining,
      });

      // Публикуем событие OrderAccepted (с минимальным контекстом)
      // Включаем strategyId для изоляции мульти-стратегии
      const orderAcceptedEvent: OrderAccepted = {
        type: 'OrderAccepted',
        orderId: domainOrder.orderId,
        strategyId: params.strategyId, // Корреляция на уровне домена
        side: params.side.toUpperCase() as 'BUY' | 'SELL',
        marketId: params.tokenId,
        price: params.price,
        size: params.size,
        timestamp: new Date(), // TODO: Использовать детерминированную временну́ю метку из params/clock
      };

      const envelope = createProductionEnvelope(
        orderAcceptedEvent,
        this.executionContext
      );

      this.eventBus.publish(envelope);

      this.logger.debug('Published OrderAccepted event', {
        orderId: domainOrder.orderId,
      });

      return domainOrder;
    } catch (error) {
      // КРИТИЧНО: API может вернуть ошибку, но ордер всё равно размещён!
      // Верифицируем реальное состояние перед публикацией OrderRejected
      this.logger.warn('Order placement returned error, verifying real state...', {
        error: error instanceof Error ? error.message : String(error),
        tokenId: params.tokenId,
        side: params.side,
      });

      try {
        // Проверяем: есть ли свежий ордер в open orders для этого token?
        const openOrders = await this.orderClient.getOpenOrders(params.tokenId);

        // Ищем ордер, созданный в последние 5 секунд с такими же параметрами
        const now = Date.now();
        const recentOrder = openOrders.find((o: any) => {
          const orderAge = now - (o.timestamp || 0);
          const matchesParams =
            o.tokenId === params.tokenId &&
            o.side === params.side.toUpperCase() &&
            Math.abs(parseFloat(o.price || '0') - params.price) < 0.001 &&
            Math.abs(parseFloat(o.size || '0') - params.size) < 0.1;

          return orderAge < 5000 && matchesParams; // Создан в последние 5 секунд
        });

        if (recentOrder) {
          // Ордер был размещён несмотря на ошибку API!
          this.logger.warn('Order was actually placed despite API error!', {
            orderId: recentOrder.orderID,
            tokenId: params.tokenId,
            side: params.side,
            apiError: error instanceof Error ? error.message : String(error),
          });

          // Конвертируем в domain format
          const domainOrder = this.mapper.toDomainOrder(recentOrder);

          // Публикуем OrderAccepted (ордер реально принят!)
          const orderAcceptedEvent: OrderAccepted = {
            type: 'OrderAccepted',
            orderId: domainOrder.orderId,
            strategyId: params.strategyId,
            side: params.side.toUpperCase() as 'BUY' | 'SELL',
            marketId: params.tokenId,
            price: params.price,
            size: params.size,
            timestamp: new Date(),
          };

          const envelope = createProductionEnvelope(
            orderAcceptedEvent,
            this.executionContext
          );

          this.eventBus.publish(envelope);

          this.logger.info('Published OrderAccepted despite API error (verified via getOpenOrders)', {
            orderId: domainOrder.orderId,
          });

          return domainOrder;
        }
      } catch (verifyError) {
        this.logger.warn('Failed to verify order state after error', {
          verifyError: verifyError instanceof Error ? verifyError.message : String(verifyError),
        });
        // Продолжаем публикацию OrderRejected
      }

      // Ордер НЕ найден в open orders → действительно rejected
      this.logger.error('Order genuinely rejected (not found in open orders)', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Публикуем событие OrderRejected (ExecutionErrorEvent)
      const orderRejectedEvent: OrderRejected = {
        type: 'OrderRejected',
        orderId: undefined, // Ордер не создан на бирже
        reason: error instanceof Error ? error.message : 'Unknown error',
        errorCode: (error as any).code || 'API_ERROR',
        timestamp: new Date(),
      };

      const envelope = createProductionEnvelope(
        orderRejectedEvent,
        this.executionContext
      );

      this.eventBus.publish(envelope);

      this.logger.debug('Published OrderRejected event', {
        reason: orderRejectedEvent.reason,
      });

      // Перебрасываем ошибку (для обработки выше по стеку)
      throw error;
    }
  }

  /**
   * Cancel order (direct API call + event publishing)
   *
   * @param orderId - Order ID to cancel
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * После успешного API call публикует OrderCancelled event
   */
  async cancelOrder(orderId: string): Promise<void> {
    // РЕЖИМ СИМУЛЯЦИИ: Пропускаем API вызов, публикуем только событие
    if (this.simulationMode) {
      this.logger.info('Cancelling order (SIMULATION MODE - virtual cancellation)', { orderId });

      // Публикуем событие OrderCancelled
      const orderCancelledEvent: OrderCancelled = {
        type: 'OrderCancelled',
        orderId,
        reason: 'User requested cancellation (SIMULATION)',
        timestamp: new Date(),
      };

      const envelope = createProductionEnvelope(
        orderCancelledEvent,
        this.executionContext
      );

      this.eventBus.publish(envelope);

      this.logger.debug('Published OrderCancelled event (SIMULATION MODE)', { orderId });
      return;
    }

    // БОЕВОЙ РЕЖИМ: Реальный API вызов
    this.logger.info('Cancelling order via API', { orderId });

    await this.orderClient.cancelOrder(orderId);

    this.logger.info('Order cancelled successfully', { orderId });

    // Публикуем событие OrderCancelled
    const orderCancelledEvent: OrderCancelled = {
      type: 'OrderCancelled',
      orderId,
      reason: 'User requested cancellation',
      timestamp: new Date(),
    };

    const envelope = createProductionEnvelope(
      orderCancelledEvent,
      this.executionContext
    );

    this.eventBus.publish(envelope);

    this.logger.debug('Published OrderCancelled event', { orderId });
  }

  /**
   * Get open orders (direct API call)
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of open orders (normalized)
   * @throws {ApiError} If API call fails
   */
  async getOpenOrders(tokenId?: string): Promise<OrderResponse[]> {
    // РЕЖИМ СИМУЛЯЦИИ: Возвращаем пустой массив (нет реальных ордеров)
    if (this.simulationMode) {
      this.logger.debug('Getting open orders (SIMULATION MODE - returning empty)', { tokenId });
      return [];
    }

    // БОЕВОЙ РЕЖИМ: Реальный API вызов
    this.logger.debug('Getting open orders', { tokenId });

    const apiOrders = await this.orderClient.getOpenOrders(tokenId);
    const domainOrders = apiOrders.map((order) => this.mapper.toDomainOrder(order));

    this.logger.debug('Open orders retrieved', {
      count: domainOrders.length,
    });

    return domainOrders;
  }

  /**
   * Get fill history
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of fills (normalized)
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns executed trades for the user.
   * This is NOT market trade history - use MarketDataAdapter for that.
   *
   * TODO: Implement when Polymarket API provides fill history endpoint.
   * For now, returns empty array.
   */
  async getFillHistory(tokenId?: string): Promise<FillResponse[]> {
    this.logger.warn('getFillHistory not yet implemented', { tokenId });

    // TODO: Реализовать когда API endpoint будет доступен
    // Пока возвращаем пустой массив
    return [];
  }

  /**
   * Get order by ID
   *
   * @param orderId - Order ID to fetch
   * @returns Order with current status
   * @throws {ApiError} If order not found
   *
   * @remarks
   * v7.7.6: Added for SCENARIO C to check order status (filled vs cancelled)
   *
   * @example
   * ```typescript
   * const order = await adapter.getOrderById('0x123...');
   * if (order.status === 'filled') {
   *   // Order was filled
   * } else if (order.status === 'cancelled') {
   *   // Order was cancelled
   * }
   * ```
   */
  async getOrderById(orderId: string): Promise<{
    orderID: string;
    status: 'pending' | 'live' | 'filled' | 'cancelled';
    filledSize?: string;
    size?: string;
  }> {
    // РЕЖИМ СИМУЛЯЦИИ: Бросаем ошибку (нет истории ордеров в симуляции)
    if (this.simulationMode) {
      this.logger.warn('getOrderById not available in SIMULATION MODE', { orderId });
      throw new Error('getOrderById not available in simulation mode');
    }

    // БОЕВОЙ РЕЖИМ: Реальный API вызов
    this.logger.debug('Getting order by ID', { orderId });

    try {
      const order = await this.orderClient.getOrderById(orderId);

      this.logger.debug('Order retrieved', {
        orderId,
        status: order.status,
        filledSize: order.filledSize,
        size: order.size,
      });

      return order;
    } catch (error) {
      this.logger.error('Failed to get order by ID', {
        error: error instanceof Error ? error.message : String(error),
        orderId,
      });
      throw error;
    }
  }
}
