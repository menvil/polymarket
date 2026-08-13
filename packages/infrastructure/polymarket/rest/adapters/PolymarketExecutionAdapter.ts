/**
 * Адаптер исполнения заявок Polymarket
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
 * Этот адаптер предполагает, что все параметры уже валидированы и нормализованы
 * политиками ДО передачи сюда.
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
 * // Параметры уже нормализованы и валидированы!
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

import type { ILogger } from '@polymarket/logger';
import type {
  IExecutionAdapter,
  PlaceOrderParams,
  OrderResponse,
  FillResponse,
  CancelOrderExecutionResponse,
} from '../../ports/IExecutionAdapter.js';
import type { PolymarketOrderRestClient, TradeResponse } from '../clients/PolymarketOrderRestClient.js';
import type { PolymarketOrderbookRestClient } from '../clients/PolymarketOrderbookRestClient.js';
import type { PolymarketOrderMapper } from '../mappers/PolymarketOrderMapper.js';
import type { IEventBus } from '../../ports/IEventBus.js';
import type {
  OrderAccepted,
  OrderCancelled,
} from '../../events/ExecutionEvent.js';
import type { ExecutionContext } from '../../events/ExecutionContext.js';
import { createProductionEnvelope } from '../../events/EventEnvelope.js';

/**
 * Адаптер исполнения заявок Polymarket
 *
 * @remarks
 * ТОЛЬКО API-вызовы + публикация событий — без бизнес-валидации!
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
    private readonly orderbookClient: PolymarketOrderbookRestClient,
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
   * Разместить ордер (ТОЛЬКО API-вызов + публикация событий, БЕЗ валидации)
   *
   * @param params - Нормализованные параметры ордера (уже валидированы!)
   * @returns Ответ с данными ордера
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * Предполагает:
   * - Размер уже нормализован (округлён до sizeTick)
   * - Баланс уже проверен
   * - Цена валидна
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
   * // Событие OrderAccepted опубликовано внутренне
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
      void this.eventBus.publish(envelope).then((result) => {
        if (!result.ok) {
          this.logger.error('Event publish failed', { error: result.error.message });
        }
      });

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
      postOnly: params.postOnly === true,
      orderType: params.orderType ?? 'GTC',
      priceTick: params.priceTick,
    });

    try {
      const book = await this.orderbookClient.getOrderbook(params.tokenId, 1);
      const negRisk = book.neg_risk === true;

      // Конвертируем параметры домена в формат API
      const apiRequest = this.mapper.toApiRequest({
        tokenId: params.tokenId,
        side: params.side,
        price: params.price,
        size: params.size,
        postOnly: params.postOnly,
        orderType: params.orderType,
        priceTick: params.priceTick,
        negRisk,
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

      void this.eventBus.publish(envelope).then((result) => {
        if (!result.ok) {
          this.logger.error('Event publish failed', { error: result.error.message });
        }
      });

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

          void this.eventBus.publish(envelope).then((result) => {
        if (!result.ok) {
          this.logger.error('Event publish failed', { error: result.error.message });
        }
      });

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
        err: error instanceof Error ? error : new Error(String(error)),
      });

      // Публикуем application-level ORDER_REJECTED.
      // В этом path ордер может отсутствовать в repo, поэтому strategyId нужен
      // для прямой маршрутизации в OrderEventBridge.
      const orderRejectedEvent = {
        type: 'ORDER_REJECTED' as const,
        orderId: params.clientOrderId ?? 'exchange-rejected',
        reason: error instanceof Error ? error.message : 'Unknown error',
        strategyId: params.strategyId,
      };

      const envelope = createProductionEnvelope(
        orderRejectedEvent,
        this.executionContext
      );

      void this.eventBus.publish(envelope).then((result) => {
        if (!result.ok) {
          this.logger.error('Event publish failed', { error: result.error.message });
        }
      });

      this.logger.debug('Published OrderRejected event', {
        orderId: orderRejectedEvent.orderId,
        strategyId: orderRejectedEvent.strategyId,
        reason: orderRejectedEvent.reason,
      });

      // Перебрасываем ошибку (для обработки выше по стеку)
      throw error;
    }
  }

  /**
   * Отменить ордер (прямой API-вызов + публикация события)
   *
   * @param orderId - Идентификатор ордера для отмены
   * @returns Структурированный ответ venue (`canceled` / `not_canceled`)
   * @throws {ApiError} При реальной HTTP/API ошибке
   *
   * @remarks
   * Публикует OrderCancelled event ТОЛЬКО если orderId реально попал в
   * `response.canceled` — `not_canceled` это business outcome (уже matched,
   * уже cancelled, not found, ...), а не успешная отмена, и не должен
   * порождать событие, семантика которого — "ордер был отменён".
   */
  async cancelOrder(orderId: string): Promise<CancelOrderExecutionResponse> {
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

      void this.eventBus.publish(envelope).then((result) => {
        if (!result.ok) {
          this.logger.error('Event publish failed', { error: result.error.message });
        }
      });

      this.logger.debug('Published OrderCancelled event (SIMULATION MODE)', { orderId });
      return { canceled: [orderId], not_canceled: {} };
    }

    // БОЕВОЙ РЕЖИМ: Реальный API вызов
    this.logger.info('Cancelling order via API', { orderId });

    const response = await this.orderClient.cancelOrder(orderId);
    const wasCanceled = response.canceled.includes(orderId);

    this.logger.info('Order cancel request completed', {
      orderId,
      canceled: wasCanceled,
    });

    // Публикуем событие OrderCancelled ТОЛЬКО при реальной отмене.
    // not_canceled — business outcome (already filled/cancelled/not found/unknown),
    // классификация которого выполняется в PolymarketExchangeClientAdapter, а не событие
    // "ордер отменён".
    if (wasCanceled) {
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

      void this.eventBus.publish(envelope).then((result) => {
        if (!result.ok) {
          this.logger.error('Event publish failed', { error: result.error.message });
        }
      });

      this.logger.debug('Published OrderCancelled event', { orderId });
    } else {
      this.logger.debug('Skipped OrderCancelled event — order not in canceled response', {
        orderId,
        notCanceledReason: response.not_canceled[orderId],
      });
    }

    return response;
  }

  /**
   * Получить открытые ордера (прямой API-вызов)
   *
   * @param tokenId - Необязательно: фильтр по идентификатору токена
   * @returns Массив открытых ордеров (нормализованных)
   * @throws {ApiError} При ошибке API-вызова
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
   * Получить историю исполнений (fills)
   *
   * @param tokenId - Необязательно: фильтр по идентификатору токена
   * @returns Массив исполнений (нормализованных)
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * Возвращает исполненные сделки пользователя.
   * Это НЕ история рыночных сделок — для этого используйте MarketDataAdapter.
   *
   * TODO: Реализовать когда Polymarket API предоставит endpoint истории исполнений.
   * Пока возвращает пустой массив.
   */
  /**
   * Получить исполнения по идентификатору ордера
   *
   * @param _orderId - Идентификатор ордера
   * @returns Массив исполнений
   *
   * @remarks
   * TODO: Реализовать когда Polymarket API предоставит endpoint истории исполнений по ордеру.
   * Пока возвращает пустой массив.
   */
  async getFills(_orderId: string): Promise<FillResponse[]> {
    this.logger.warn('getFills not yet implemented');
    return [];
  }

  async getFillHistory(tokenId?: string): Promise<FillResponse[]> {
    this.logger.warn('getFillHistory not yet implemented', { tokenId });

    // TODO: Реализовать когда API endpoint будет доступен
    // Пока возвращаем пустой массив
    return [];
  }

  /**
   * Получить исполненные сделки через /data/trades.
   *
   * @param tokenId - Фильтр по идентификатору токена (опционально)
   * @returns Массив TradeResponse с деталями сделок
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * Делегирует в `PolymarketOrderRestClient.getFilledOrders()`.
   *
   * @remarks
   * НЕ передаём maker_address — API с maker_address возвращает только trades
   * где мы были maker. Мгновенно matched ордера (taker fills) не попадут
   * в выборку и reconciliation их не найдёт. Без фильтра API возвращает
   * все наши trades (и maker и taker).
   */
  async getFilledOrders(tokenId?: string, options?: { onlyFirstPage?: boolean }): Promise<TradeResponse[]> {
    return this.orderClient.getFilledOrders(tokenId, undefined, 100, options);
  }

  /**
   * Получить ордер по идентификатору
   *
   * @param orderId - Идентификатор ордера для получения
   * @returns Ордер с текущим статусом
   * @throws {ApiError} Если ордер не найден
   *
   * @remarks
   * v7.7.6: Добавлено для СЦЕНАРИЯ C для проверки статуса ордера (исполнен или отменён)
   *
   * @example
   * ```typescript
   * const order = await adapter.getOrderById('0x123...');
   * if (order.status === 'filled') {
   *   // Ордер исполнен
   * } else if (order.status === 'cancelled') {
   *   // Ордер отменён
   * }
   * ```
   */
  async getOrderById(orderId: string): Promise<{
    orderID: string;
    status: 'pending' | 'live' | 'filled' | 'cancelled' | 'matched' | 'delayed' | 'unmatched';
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
        err: error instanceof Error ? error : new Error(String(error)),
        orderId,
      });
      throw error;
    }
  }
}
