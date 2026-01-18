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
 *   marketId: 'condition-123',
 *   tokenId: '0x123',
 *   side: 'BUY',
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
import { ApiError } from '../../../../shared/errors/TradingError.js';

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
   * Временное окно для поиска недавних ордеров (мс)
   * Используется для определения дубликатов при ошибках API
   */
  private static readonly RECENT_ORDER_WINDOW_MS = 5000; // 5 секунд

  /**
   * Толерантность сравнения цены
   * Два ордера считаются идентичными если разница цен < этого значения
   */
  private static readonly PRICE_TOLERANCE = 0.001;

  /**
   * Толерантность сравнения размера
   * Два ордера считаются идентичными если разница размеров < этого значения
   */
  private static readonly SIZE_TOLERANCE = 0.1;

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
   *   marketId: 'condition-123',
   *   tokenId: '0x123',
   *   side: 'BUY',
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
        status: 'OPEN',
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
        strategyId: params.strategyId ?? 'default',
        marketId: params.marketId,
        tokenId: params.tokenId,
        side: params.side,
        price: params.price,
        size: params.size,
        timestamp: params.timestamp ?? new Date(),
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
        strategyId: params.strategyId ?? 'default',
        marketId: params.marketId,
        tokenId: params.tokenId,
        side: params.side,
        price: params.price,
        size: params.size,
        timestamp: params.timestamp ?? new Date(),
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
        const rawOpenOrders = await this.orderClient.getOpenOrders(params.tokenId);

        // ✅ КРИТИЧНО: Нормализуем через mapper ПЕРЕД сравнением!
        // Raw API возвращает: snake_case поля, строковые price/size, разный формат timestamp
        // Без нормализации сравнение может дать false negative → ложный OrderRejected
        const normalizedOrders = rawOpenOrders.map(raw => this.mapper.toDomainOrder(raw));

        // Ищем недавно созданный ордер с такими же параметрами
        const now = Date.now();
        const recentOrder = normalizedOrders.find(order => {
          const orderAge = now - order.createdAt;
          const matchesParams =
            order.tokenId === params.tokenId &&
            order.side === params.side &&
            Math.abs(order.price - params.price) < PolymarketExecutionAdapter.PRICE_TOLERANCE &&
            Math.abs(order.size - params.size) < PolymarketExecutionAdapter.SIZE_TOLERANCE;

          return orderAge < PolymarketExecutionAdapter.RECENT_ORDER_WINDOW_MS && matchesParams;
        });

        if (recentOrder) {
          // ✅ Ордер был размещён несмотря на ошибку API!
          this.logger.warn('Order was actually placed despite API error!', {
            orderId: recentOrder.orderId,
            tokenId: params.tokenId,
            side: params.side,
            apiError: error instanceof Error ? error.message : String(error),
          });

          // Ордер уже нормализован - используем напрямую
          const domainOrder = recentOrder;

          // Публикуем OrderAccepted (ордер реально принят!)
          const orderAcceptedEvent: OrderAccepted = {
            type: 'OrderAccepted',
            orderId: domainOrder.orderId,
            strategyId: params.strategyId ?? 'default',
            marketId: params.marketId,
            tokenId: params.tokenId,
            side: params.side,
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
        strategyId: params.strategyId ?? 'default',
        marketId: params.marketId,
        tokenId: params.tokenId,
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
  async cancelOrder(
    orderId: string,
    context?: { marketId: string; tokenId: string; strategyId: string }
  ): Promise<void> {
    // РЕЖИМ СИМУЛЯЦИИ: Пропустить API-вызов, только опубликовать событие
    if (this.simulationMode) {
      this.logger.info('Cancelling order (SIMULATION MODE - virtual cancellation)', { orderId });

      // Публикация события OrderCancelled
      const orderCancelledEvent: OrderCancelled = {
        type: 'OrderCancelled',
        orderId,
        strategyId: context?.strategyId ?? 'default',
        marketId: context?.marketId ?? 'unknown',
        tokenId: context?.tokenId ?? 'unknown',
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
      strategyId: context?.strategyId ?? 'default',
      marketId: context?.marketId ?? 'unknown',
      tokenId: context?.tokenId ?? 'unknown',
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
   * @param _tokenId - Опционально: фильтр по ID токена
   * @returns Массив исполнений (нормализованный)
   * @throws {ApiError} Polymarket API не предоставляет этот эндпоинт
   *
   * @remarks
   * Polymarket CLOB API не поддерживает получение истории исполнений.
   * Альтернативы: getOpenOrders() для ордеров, MarketDataAdapter для истории рынка.
   *
   * @deprecated Метод не реализован. Используйте getOpenOrders() для получения ордеров
   * или MarketDataAdapter для истории сделок рынка.
   */
  async getFillHistory(_tokenId?: string): Promise<FillResponse[]> {
    throw new ApiError(
      'getFillHistory not implemented: Polymarket API endpoint not available. ' +
      'Use getOpenOrders() for order tracking or MarketDataAdapter for market trade history.',
      { endpoint: '/fills', method: 'GET' }
    );
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
   * const rawOrder = await adapter.getOrderById('0x123...');
   * // Примечание: возвращает сырой формат API (lowercase statuses)
   * if (rawOrder.status === 'filled') {
   *   // Ордер был исполнен
   * } else if (rawOrder.status === 'cancelled') {
   *   // Ордер был отменён
   * }
   * ```
   *
   * @remarks
   * TODO: Рефакторинг для возврата OrderResponse через mapper
   */
  async getOrderById(orderId: string): Promise<{
    orderID: string;
    status: 'pending' | 'live' | 'filled' | 'cancelled'; // Сырой формат API
    filledSize?: string;
    size?: string;
  }> {
    // РЕЖИМ СИМУЛЯЦИИ: Выбросить ошибку (нет истории ордеров в симуляции)
    if (this.simulationMode) {
      this.logger.warn('getOrderById not available in SIMULATION MODE', { orderId });
      throw new Error('getOrderById not available in simulation mode');
    }

    // РЕЖИМ LIVE: Реальный API-вызов
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
