/**
 * PolymarketTradingGateway - ТУПОЙ gateway (БЕЗ policies, БЕЗ decisions)
 *
 * @remarks
 * Реализация ITradingGateway для Polymarket CLOB API.
 *
 * КРИТИЧЕСКИ ВАЖНО - Gateway ТУПОЙ:
 * ❌ НЕТ валидации (это ValidationPipeline)
 * ❌ НЕТ нормализации (это IntentNormalizer)
 * ❌ НЕТ проверки баланса (это ValidationContextProvider)
 * ❌ НЕТ retry logic (это upstream responsibility)
 * ❌ НЕТ rate limiting (это upstream responsibility)
 * ❌ НЕТ circuit breaker (это upstream responsibility)
 * ❌ НЕТ принятия решений (это Decision Layer)
 *
 * РАЗРЕШЕНО (ТОЛЬКО ЭТО):
 * ✅ Конвертировать Domain → API (OrderMapper.toApi)
 * ✅ Вызывать HTTP (CLOBClient)
 * ✅ Маппить HTTP errors → ExchangeError (PolymarketErrorMapper)
 * ✅ Конвертировать API → Domain (OrderMapper.fromApi)
 * ✅ Возвращать Result (НЕ бросает exceptions)
 *
 * Алгоритм placeOrder():
 * 1. Order → PlaceOrderParams (OrderMapper.toApi)
 * 2. HTTP POST /order (CLOBClient.placeOrder)
 * 3. Обработать response:
 *    - Success: PlaceOrderResponse → Order (OrderMapper.fromApi) → Ok(Order)
 *    - Error: HTTP error → ExchangeError (PolymarketErrorMapper) → Err(FAILED)
 *
 * SLA (Service Level Agreement):
 * - Timeout: 30s (от HttpClient)
 * - Retries: 0 (НЕТ retry в Gateway)
 * - Circuit breaker: НЕТ
 * - Rate limiting: НЕТ
 * - Error handling: ВСЕ exceptions → ExchangeError
 *
 * ГАРАНТИИ:
 * - НЕ бросает exceptions (всегда Result)
 * - Детерминированный error mapping
 * - Изоляция HTTP от Domain Layer
 * - Structured logging
 *
 * @example
 * ```typescript
 * // Production flow
 * const gateway = new PolymarketTradingGateway(clobClient, logger);
 *
 * // Gateway ожидает VALIDATED order (прошёл ValidationPipeline)
 * const validatedOrder = ...; // от ValidationPipeline
 * const result = await gateway.placeOrder(validatedOrder);
 *
 * if (result.ok) {
 *   console.log('Order placed:', result.value.id);
 * } else {
 *   // Всегда ExchangeError (не ValidationError)
 *   if (result.error.kind === 'FAILED') {
 *     console.error('Exchange error:', result.error.error.type);
 *   }
 * }
 * ```
 */

import type { ITradingGateway } from '../../../domain/ports/ITradingGateway.js';
import type { Order } from '../../../domain/entities/Order.js';
import type { PlaceOrderResult, CancelOrderResult, GetOrdersResult } from '../../../domain/types/ExecutionResult.js';
import type { ExchangeError } from '../../../domain/types/ExchangeError.js';
import type { CLOBClient } from '../clients/CLOBClient.js';
import type { ILogger } from '../../../domain/ports/ILogger.js';
import { OrderMapper } from '../mappers/OrderMapper.js';
import { PolymarketErrorMapper } from '../mappers/PolymarketErrorMapper.js';
import { Ok, Err } from '../../../shared/types/Result.js';

/**
 * HttpError - ошибка от HttpClient
 *
 * @remarks
 * Временный тип для typing HttpClient errors.
 * В реальности HttpClient может бросать разные типы ошибок.
 */
interface HttpError extends Error {
  statusCode?: number;
  response?: unknown;
}

/**
 * PolymarketTradingGateway - тупой gateway для Polymarket CLOB
 *
 * @remarks
 * Stateful класс (хранит dependencies), но НЕ хранит бизнес-логику.
 * Все методы транслируют Domain → HTTP → Domain (без решений).
 */
export class PolymarketTradingGateway implements ITradingGateway {
  /**
   * Создаёт PolymarketTradingGateway
   *
   * @param clobClient - CLOB API client для HTTP запросов
   * @param logger - Logger для structured logging
   *
   * @remarks
   * Dependencies:
   * - CLOBClient: делает HTTP запросы (с auth, signing)
   * - ILogger: structured logging (observability)
   *
   * НЕТ dependencies на:
   * - ValidationPipeline ❌
   * - IntentNormalizer ❌
   * - BalancePolicy ❌
   * - MarketConstraintsPolicy ❌
   */
  constructor(
    private readonly clobClient: CLOBClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Размещает ордер (БЕЗ валидации)
   *
   * @param order - ALREADY VALIDATED order (прошёл ValidationPipeline)
   * @returns PlaceOrderResult (Ok или Err(FAILED))
   *
   * @remarks
   * ОЖИДАЕТ что order УЖЕ:
   * - Нормализован (IntentNormalizer)
   * - Провалидирован (ValidationPipeline)
   * - Проверен по балансу
   * - Проверен по лимитам
   *
   * Gateway НЕ ВЫПОЛНЯЕТ повторную валидацию.
   * Gateway ТОЛЬКО транслирует в HTTP и маппит ответ.
   *
   * Алгоритм:
   * 1. Log начала операции
   * 2. Order → PlaceOrderParams (OrderMapper.toApi)
   * 3. HTTP POST /order (CLOBClient.placeOrder)
   * 4. Обработать ответ:
   *    - Success: API → Domain (OrderMapper.fromApi) → Ok(Order)
   *    - Error: HTTP error → ExchangeError → Err(FAILED)
   * 5. Log результата
   *
   * Возвращает:
   * - Ok(Order): ордер успешно размещён (получен orderID от биржи)
   * - Err({ kind: 'FAILED', error: ExchangeError }): биржа отказала
   *
   * НЕ возвращает:
   * - Err({ kind: 'REJECTED' }): это ValidationPipeline responsibility
   *
   * SLA:
   * - Timeout: 30s (от HttpClient)
   * - Retries: 0
   * - НЕ бросает exceptions (всегда Result)
   *
   * @example
   * ```typescript
   * const validatedOrder = ...; // от ValidationPipeline
   * const result = await gateway.placeOrder(validatedOrder);
   *
   * if (result.ok) {
   *   console.log('Order ID:', result.value.id);
   * } else {
   *   console.error('Failed:', result.error.error.type);
   * }
   * ```
   */
  public async placeOrder(order: Order): Promise<PlaceOrderResult> {
    this.logger.debug('[PolymarketTradingGateway] Placing order', {
      orderId: order.id,
      tokenId: order.tokenId.substring(0, 16) + '...',
      side: order.side,
      price: order.price.value,
      size: order.size.value,
    });

    try {
      // Step 1: Domain Order → API params
      const apiParams = OrderMapper.toApi(order);

      // Step 2: HTTP POST /order
      const apiResponse = await this.clobClient.placeOrder(apiParams);

      // Step 3: API response → Domain Order
      const placedOrder = OrderMapper.fromPlaceOrderResponse(apiResponse);

      this.logger.info('[PolymarketTradingGateway] Order placed successfully', {
        orderId: placedOrder.id,
        status: placedOrder.status,
        timestamp: placedOrder.timestamp.toISOString(),
      });

      return Ok(placedOrder);
    } catch (error) {
      // Step 4: HTTP error → ExchangeError
      const exchangeError = this.mapHttpErrorToExchangeError(error);

      this.logger.error('[PolymarketTradingGateway] Order placement failed', {
        orderId: order.id,
        errorType: exchangeError.type,
        errorMessage: this.getErrorMessage(exchangeError),
      });

      return Err({
        kind: 'FAILED',
        error: exchangeError,
      });
    }
  }

  /**
   * Отменяет ордер
   *
   * @param orderId - ID ордера для отмены
   * @returns CancelOrderResult (Ok или Err(FAILED))
   *
   * @remarks
   * Отправляет запрос на отмену в CLOB.
   * Асинхронная операция - подтверждение может прийти через WebSocket.
   *
   * Алгоритм:
   * 1. Log начала операции
   * 2. HTTP DELETE /order (CLOBClient.cancelOrder)
   * 3. Обработать ответ:
   *    - Success: void → Ok(void)
   *    - Error: HTTP error → ExchangeError → Err(FAILED)
   * 4. Log результата
   *
   * Возвращает:
   * - Ok(void): cancel request отправлен успешно
   * - Err({ kind: 'FAILED', error: ExchangeError }): биржа отказала
   *
   * Возможные ExchangeError:
   * - ORDER_NOT_FOUND (404): ордер уже отменён/исполнен
   * - RATE_LIMITED (429): слишком много cancel requests
   * - SERVER_ERROR (5xx): временная проблема биржи
   * - NETWORK_ERROR: timeout/connection
   * - FATAL: неизвестная ошибка
   *
   * @example
   * ```typescript
   * const result = await gateway.cancelOrder('0x123abc');
   *
   * if (result.ok) {
   *   console.log('Cancel request sent');
   * } else {
   *   if (result.error.error.type === 'ORDER_NOT_FOUND') {
   *     console.log('Order already cancelled/filled');
   *   }
   * }
   * ```
   */
  public async cancelOrder(orderId: string): Promise<CancelOrderResult> {
    this.logger.debug('[PolymarketTradingGateway] Cancelling order', {
      orderId: orderId.substring(0, 16) + '...',
    });

    try {
      // HTTP DELETE /order
      await this.clobClient.cancelOrder({ orderId });

      this.logger.info('[PolymarketTradingGateway] Order cancelled successfully', {
        orderId: orderId.substring(0, 16) + '...',
      });

      return Ok(undefined);
    } catch (error) {
      // HTTP error → ExchangeError
      const exchangeError = this.mapHttpErrorToExchangeError(error);

      this.logger.error('[PolymarketTradingGateway] Order cancellation failed', {
        orderId: orderId.substring(0, 16) + '...',
        errorType: exchangeError.type,
        errorMessage: this.getErrorMessage(exchangeError),
      });

      return Err({
        kind: 'FAILED',
        error: exchangeError,
      });
    }
  }

  /**
   * Получает все открытые ордера
   *
   * @param tokenId - Опциональный фильтр по tokenId
   * @returns GetOrdersResult (Ok(Order[]) или Err(FAILED))
   *
   * @remarks
   * Запрашивает список открытых ордеров от биржи.
   *
   * Алгоритм:
   * 1. Log начала операции
   * 2. HTTP GET /orders (CLOBClient.getOrders)
   * 3. Обработать ответ:
   *    - Success: API[] → Domain Order[] (OrderMapper.fromApi) → Ok(Order[])
   *    - Error: HTTP error → ExchangeError → Err(FAILED)
   * 4. Log результата
   *
   * Возвращает:
   * - Ok(Order[]): массив открытых ордеров (PENDING/OPEN)
   * - Err({ kind: 'FAILED', error: ExchangeError }): биржа отказала
   *
   * Фильтрация:
   * - Если tokenId указан → только ордера для этого токена
   * - Если tokenId не указан → все открытые ордера
   *
   * @example
   * ```typescript
   * // Все открытые ордера
   * const result = await gateway.getOpenOrders();
   * if (result.ok) {
   *   console.log(`Found ${result.value.length} open orders`);
   * }
   *
   * // Ордера для конкретного токена
   * const result = await gateway.getOpenOrders('0x123...');
   * ```
   */
  public async getOpenOrders(tokenId?: string): Promise<GetOrdersResult> {
    this.logger.debug('[PolymarketTradingGateway] Fetching open orders', {
      tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
    });

    try {
      // HTTP GET /orders
      const apiOrders = await this.clobClient.getOrders(tokenId);

      // API[] → Domain Order[]
      const orders = apiOrders.map((apiOrder) => OrderMapper.fromPlaceOrderResponse(apiOrder));

      this.logger.info('[PolymarketTradingGateway] Orders fetched successfully', {
        count: orders.length,
        tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      });

      return Ok(orders);
    } catch (error) {
      // HTTP error → ExchangeError
      const exchangeError = this.mapHttpErrorToExchangeError(error);

      this.logger.error('[PolymarketTradingGateway] Failed to fetch orders', {
        tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
        errorType: exchangeError.type,
        errorMessage: this.getErrorMessage(exchangeError),
      });

      return Err({
        kind: 'FAILED',
        error: exchangeError,
      });
    }
  }

  /**
   * Извлекает сообщение об ошибке из ExchangeError
   *
   * @param error - ExchangeError любого типа
   * @returns Строка с описанием ошибки
   *
   * @remarks
   * Разные типы ExchangeError имеют разные поля для сообщения:
   * - RateLimitedError, ServerError, NetworkError, FatalExchangeError: `message`
   * - AuthFailedError, MarketClosedError: `reason`
   * - OrderNotFoundError: `orderId`
   */
  private getErrorMessage(error: ExchangeError): string {
    switch (error.type) {
      case 'RATE_LIMITED':
      case 'SERVER_ERROR':
      case 'NETWORK_ERROR':
      case 'FATAL':
        return error.message;
      case 'AUTH_FAILED':
      case 'MARKET_CLOSED':
        return error.reason;
      case 'ORDER_NOT_FOUND':
        return `Order not found: ${error.orderId}`;
      default:
        // Exhaustiveness check
        const _exhaustive: never = error;
        return String(_exhaustive);
    }
  }

  /**
   * Маппит HTTP error → ExchangeError
   *
   * @param error - Ошибка от CLOBClient (может быть любого типа)
   * @returns ExchangeError (детерминированный)
   *
   * @remarks
   * Использует PolymarketErrorMapper для детерминированного маппинга.
   *
   * Обрабатывает:
   * - HttpError (с statusCode и response)
   * - Error (generic ошибка)
   * - unknown (неизвестный тип)
   *
   * Алгоритм:
   * 1. Проверить тип ошибки
   * 2. Извлечь httpStatus и responseBody
   * 3. Вызвать PolymarketErrorMapper.mapHttpError()
   * 4. Вернуть ExchangeError
   *
   * ГАРАНТИЯ:
   * - НЕ бросает exceptions (всегда возвращает ExchangeError)
   * - Детерминированный (одинаковая ошибка → одинаковый ExchangeError)
   *
   * @example
   * ```typescript
   * try {
   *   await this.clobClient.placeOrder(params);
   * } catch (error) {
   *   const exchangeError = this.mapHttpErrorToExchangeError(error);
   *   // exchangeError: ExchangeError (всегда)
   * }
   * ```
   */
  private mapHttpErrorToExchangeError(error: unknown) {
    // Проверяем типы ошибок и извлекаем httpStatus и responseBody

    // Case 1: HttpError (с statusCode и response)
    if (this.isHttpError(error)) {
      const httpStatus = error.statusCode || 0;
      const responseBody = error.response;

      return PolymarketErrorMapper.mapHttpError(httpStatus, responseBody, error);
    }

    // Case 2: Error (generic, без statusCode)
    if (error instanceof Error) {
      // Сетевая ошибка (нет HTTP response)
      return PolymarketErrorMapper.mapHttpError(0, undefined, error);
    }

    // Case 3: unknown (неизвестный тип)
    return PolymarketErrorMapper.mapHttpError(0, undefined, new Error(String(error)));
  }

  /**
   * Type guard для HttpError
   *
   * @param error - Любая ошибка
   * @returns true если ошибка имеет statusCode
   *
   * @remarks
   * Проверяет наличие поля statusCode (признак HTTP ошибки).
   *
   * @example
   * ```typescript
   * if (this.isHttpError(error)) {
   *   console.log('HTTP status:', error.statusCode);
   * }
   * ```
   */
  private isHttpError(error: unknown): error is HttpError {
    return (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof (error as HttpError).statusCode === 'number'
    );
  }
}
