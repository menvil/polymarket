/**
 * Адаптер исполнения для Polymarket
 *
 * @remarks
 * ТОЛЬКО API-вызовы + публикация событий, БЕЗ валидации, БЕЗ проверки баланса.
 * Реализует IExecutionAdapter.
 *
 * Ключевой принцип: **Разделение ответственности**
 * - Валидация → BalancePolicy, MarketConstraintsPolicy
 * - API-вызовы → ExecutionAdapter (этот класс)
 * - Публикация событий → ExecutionAdapter (после API-вызовов)
 * - Оркестрация → RestAdapter (Фасад)
 *
 * Этот адаптер предполагает, что все параметры уже проверены и нормализованы
 * политиками ДО передачи сюда.
 *
 * После API-вызова публикует ExecutionEvent в EventBus
 * - postOrder успех → OrderAccepted (с минимальным контекстом)
 * - postOrder ошибка → OrderRejected (ExecutionErrorEvent)
 * - cancelOrder успех → OrderCancelled
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
 * // Параметры уже нормализованы и проверены!
 * const order = await adapter.postOrder({
 *   tokenId: '0x123',
 *   side: 'buy',
 *   price: 0.52,
 *   size: 100, // Уже округлено до sizeTick
 * });
 *
 * // ExecutionAdapter опубликовал событие OrderAccepted внутренне
 * console.log(`Order placed: ${order.orderId}`);
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type {
  IExecutionAdapter,
  PlaceOrderParams,
  OrderResponse,
  FillResponse,
} from '../../../exchange/ports/IExecutionAdapter.js';
import type { PolymarketOrderRestClient } from '../clients/PolymarketOrderRestClient.js';
import type { PolymarketOrderMapper } from '../mappers/PolymarketOrderMapper.js';
import type { IEventBus } from '../../../../shared/events/IEventBus.js';
import type {
  OrderAccepted,
  OrderCancelled,
  OrderRejected,
} from '../../../../domain/events/ExecutionEvent.js';
import type { ExecutionContext } from '../../../../domain/execution/ExecutionContext.js';
import { createProductionEnvelope } from '../../../../shared/events/EventEnvelope.js';

/**
 * Адаптер исполнения для Polymarket
 *
 * @remarks
 * ТОЛЬКО API-вызовы + публикация событий - без бизнес-валидации!
 *
 * Публикует ExecutionEvent в EventBus после каждого API-вызова
 */
export class PolymarketExecutionAdapter implements IExecutionAdapter {
  /**
   * ExecutionContext для всех событий (окружение LIVE)
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
    // По умолчанию: окружение LIVE (продакшн трейдинг)
    this.executionContext = executionContext || {
      environment: 'LIVE',
      accountId: 'default',
    };
  }

  /**
   * Разместить ордер (ТОЛЬКО API-вызов + публикация событий, БЕЗ валидации)
   *
   * @param params - Нормализованные параметры ордера (уже проверены!)
   * @returns Ответ с информацией об ордере
   * @throws {ApiError} Если API-вызов не удался
   *
   * @remarks
   * Предполагается:
   * - Размер уже нормализован (округлен до sizeTick)
   * - Баланс уже проверен
   * - Цена валидна
   *
   * После успешного API-вызова публикует событие OrderAccepted
   * При ошибке публикует событие OrderRejected (ExecutionErrorEvent)
   *
   * @example
   * ```typescript
   * const order = await adapter.postOrder({
   *   tokenId: '0x123',
   *   side: 'buy',
   *   price: 0.52,
   *   size: 100,
   * });
   * // Событие OrderAccepted опубликовано внутренне
   * ```
   */
  async postOrder(params: PlaceOrderParams): Promise<OrderResponse> {
    // РЕЖИМ СИМУЛЯЦИИ: Пропустить API-вызов, вернуть виртуальный ордер
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

      // Публикация события OrderAccepted
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

    // РЕЖИМ LIVE: Реальный API-вызов
    this.logger.info('Placing order via API', {
      tokenId: params.tokenId,
      side: params.side,
      price: params.price,
      size: params.size,
      priceTick: params.priceTick,
    });

    try {
      // Преобразование доменных параметров в формат API
      const apiRequest = this.mapper.toApiRequest({
        tokenId: params.tokenId,
        side: params.side,
        price: params.price,
        size: params.size,
        priceTick: params.priceTick,
        feeRateBps: params.feeRateBps, // Использовать изученную или стандартную ставку комиссии
      });

      // Выполнение API-вызова
      const apiResponse = await this.orderClient.createOrder(apiRequest);

      // Преобразование ответа API в доменный формат
      const domainOrder = this.mapper.toDomainOrder(apiResponse);

      this.logger.info('Order placed successfully', {
        orderId: domainOrder.orderId,
        status: domainOrder.status,
        sizeRemaining: domainOrder.sizeRemaining,
      });

      // Публикация события OrderAccepted (с минимальным контекстом)
      const orderAcceptedEvent: OrderAccepted = {
        type: 'OrderAccepted',
        orderId: domainOrder.orderId,
        strategyId: params.strategyId,
        side: params.side.toUpperCase() as 'BUY' | 'SELL',
        marketId: params.tokenId,
        price: params.price,
        size: params.size,
        timestamp: new Date(), // TODO: Использовать детерминированный timestamp из params/clock
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
      // API может вернуть ошибку, но ордер всё равно размещён!
      // Верифицируем реальное состояние перед публикацией OrderRejected
      this.logger.warn('Order placement returned error, verifying real state...', {
        error: error instanceof Error ? error.message : String(error),
        tokenId: params.tokenId,
        side: params.side,
      });

      try {
        // Проверяем: есть ли свежий ордер в открытых ордерах для этого токена?
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
          // ✅ Ордер был размещён несмотря на ошибку API!
          this.logger.warn('Order was actually placed despite API error!', {
            orderId: recentOrder.orderID,
            tokenId: params.tokenId,
            side: params.side,
            apiError: error instanceof Error ? error.message : String(error),
          });

          // Преобразуем в доменный формат
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
        // Продолжаем публиковать OrderRejected
      }

      // Ордер НЕ найден в открытых ордерах → действительно отклонён
      this.logger.error('Order genuinely rejected (not found in open orders)', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Публикация события OrderRejected (ExecutionErrorEvent)
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

      // Перебросить ошибку (для обработки выше в стеке)
      throw error;
    }
  }

  /**
   * Отменить ордер (прямой API-вызов + публикация событий)
   *
   * @param orderId - ID ордера для отмены
   * @throws {ApiError} Если API-вызов не удался
   *
   * @remarks
   * После успешного API-вызова публикует событие OrderCancelled
   */
  async cancelOrder(orderId: string): Promise<void> {
    // РЕЖИМ СИМУЛЯЦИИ: Пропустить API-вызов, только опубликовать событие
    if (this.simulationMode) {
      this.logger.info('Cancelling order (SIMULATION MODE - virtual cancellation)', { orderId });

      // Публикация события OrderCancelled
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

    // РЕЖИМ LIVE: Реальный API-вызов
    this.logger.info('Cancelling order via API', { orderId });

    await this.orderClient.cancelOrder(orderId);

    this.logger.info('Order cancelled successfully', { orderId });

    // Публикация события OrderCancelled
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
   * Получить открытые ордера (прямой API-вызов)
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив открытых ордеров (нормализованный)
   * @throws {ApiError} Если API-вызов не удался
   */
  async getOpenOrders(tokenId?: string): Promise<OrderResponse[]> {
    // РЕЖИМ СИМУЛЯЦИИ: Вернуть пустой массив (нет реальных ордеров)
    if (this.simulationMode) {
      this.logger.debug('Getting open orders (SIMULATION MODE - returning empty)', { tokenId });
      return [];
    }

    // РЕЖИМ LIVE: Реальный API-вызов
    this.logger.debug('Getting open orders', { tokenId });

    const apiOrders = await this.orderClient.getOpenOrders(tokenId);
    const domainOrders = apiOrders.map((order) => this.mapper.toDomainOrder(order));

    this.logger.debug('Open orders retrieved', {
      count: domainOrders.length,
    });

    return domainOrders;
  }

  /**
   * Получить историю исполнений
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив исполнений (нормализованный)
   * @throws {ApiError} Если API-вызов не удался
   *
   * @remarks
   * Возвращает исполненные сделки для пользователя.
   * Это НЕ история сделок рынка - используйте MarketDataAdapter для этого.
   *
   * TODO: Реализовать, когда Polymarket API предоставит эндпоинт истории исполнений.
   * Пока возвращает пустой массив.
   */
  async getFillHistory(tokenId?: string): Promise<FillResponse[]> {
    this.logger.warn('getFillHistory not yet implemented', { tokenId });

    // TODO: Реализовать, когда эндпоинт API будет доступен
    // Пока возвращаем пустой массив
    return [];
  }

  /**
   * Получить ордер по ID
   *
   * @param orderId - ID ордера для получения
   * @returns Ордер с текущим статусом
   * @throws {ApiError} Если ордер не найден
   *
   * @remarks
   * v7.7.6: Добавлено для СЦЕНАРИЯ C для проверки статуса ордера (исполнен vs отменён)
   *
   * @example
   * ```typescript
   * const order = await adapter.getOrderById('0x123...');
   * if (order.status === 'filled') {
   *   // Ордер был исполнен
   * } else if (order.status === 'cancelled') {
   *   // Ордер был отменён
   * }
   * ```
   */
  async getOrderById(orderId: string): Promise<{
    orderID: string;
    status: 'pending' | 'live' | 'filled' | 'cancelled';
    filledSize?: string;
    size?: string;
  }> {
    // SIMULATION MODE: Throw error (no order history in simulation)
    if (this.simulationMode) {
      this.logger.warn('getOrderById not available in SIMULATION MODE', { orderId });
      throw new Error('getOrderById not available in simulation mode');
    }

    // LIVE MODE: Real API call
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
