/**
 * ITradingGateway - тупой транслятор команд в HTTP
 *
 * @remarks
 * Gateway - это МАКСИМАЛЬНО ТУПОЙ слой.
 * Единственная ответственность: транслировать Domain → API → Domain.
 *
 * ЗАПРЕТЫ (НЕ ДЕЛАЕТ):
 * ❌ Валидация (это Policy Pipeline)
 * ❌ Нормализация (это IntentNormalizer)
 * ❌ Проверка баланса (это BalancePolicy)
 * ❌ Retry logic (это upstream responsibility)
 * ❌ Rate limiting (это upstream responsibility)
 * ❌ Circuit breaker (это upstream responsibility)
 * ❌ Принятие решений (это Decision Layer)
 *
 * РАЗРЕШЕНО (ТОЛЬКО ЭТО):
 * ✅ Конвертировать Domain → API params (OrderMapper.toApi)
 * ✅ Вызывать HTTP (CLOBClient)
 * ✅ Маппить HTTP errors → ExchangeError (PolymarketErrorMapper)
 * ✅ Конвертировать API response → Domain Order (OrderMapper.fromApi)
 * ✅ Возвращать Result (НЕ бросает exceptions)
 *
 * SLA (Service Level Agreement):
 * - Timeout: наследуется от HttpClient (30s default)
 * - Retries: 0 (НЕТ retry в Gateway, это upstream responsibility)
 * - Circuit breaker: НЕТ (это upstream responsibility)
 * - Rate limiting: НЕТ (это upstream responsibility)
 * - Error handling: маппит ВСЕ exceptions → ExchangeError
 *
 * ГАРАНТИИ:
 * - НЕ бросает exceptions (всегда возвращает Result)
 * - Детерминированный error mapping (одинаковый HTTP → одинаковый ExchangeError)
 * - Изоляция HTTP от Domain Layer
 * - Structured logging (с correlationId)
 *
 * ВАЖНО:
 * Gateway получает ALREADY VALIDATED order (прошёл ValidationPipeline).
 * Если validation не прошла → ExecutionService возвращает REJECTED ДО вызова Gateway.
 *
 * @example
 * ```typescript
 * // Production flow:
 * // 1. ValidationPipeline.validate(order, context) → Ok(validatedOrder)
 * // 2. Gateway.placeOrder(validatedOrder) → Result<Order, ExchangeError>
 *
 * const gateway = new PolymarketTradingGateway(clobClient, logger);
 *
 * // Gateway ожидает VALIDATED order
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

import type { PlaceOrderResult, CancelOrderResult, GetOrdersResult } from '../types/ExecutionResult.js';
import type { Order } from '../entities/Order.js';

/**
 * ITradingGateway - интерфейс тупого execution gateway
 *
 * @remarks
 * Реализации:
 * - PolymarketTradingGateway (production)
 * - MockTradingGateway (tests)
 * - BacktestTradingGateway (backtest/simulation)
 */
export interface ITradingGateway {
  /**
   * Размещает ордер (БЕЗ валидации)
   *
   * @param order - ALREADY VALIDATED order (прошёл ValidationPipeline)
   * @returns PlaceOrderResult (только FAILED, не REJECTED)
   *
   * @remarks
   * ОЖИДАЕТ что order УЖЕ:
   * - Нормализован (size округлён по sizeTick)
   * - Провалидирован (прошёл все проверки ValidationPipeline)
   * - Проверен по балансу (BalancePolicy)
   * - Проверен по лимитам (PositionLimitPolicy)
   *
   * Gateway НЕ ВЫПОЛНЯЕТ повторную валидацию.
   * Gateway ТОЛЬКО транслирует в HTTP и маппит ответ.
   *
   * Возвращает:
   * - Ok(Order): ордер успешно размещён (получен orderID от биржи)
   * - Err({ kind: 'FAILED', error: ExchangeError }): биржа отказала
   *
   * Возможные ExchangeError:
   * - RATE_LIMITED (429): биржа throttle, upstream должен подождать retryAfter
   * - AUTH_FAILED (401/403): invalid signature, upstream должен проверить credentials
   * - MARKET_CLOSED (400): рынок закрыт, upstream должен переключиться на другой
   * - SERVER_ERROR (5xx): временная проблема биржи, upstream может retry
   * - NETWORK_ERROR: timeout/connection, upstream может retry
   * - FATAL: неизвестная ошибка, upstream ДОЛЖЕН остановить стратегию
   *
   * SLA:
   * - Timeout: 30s (от HttpClient)
   * - Retries: 0 (upstream responsibility)
   * - НЕ бросает exceptions (всегда Result)
   *
   * @example
   * ```typescript
   * // ПРАВИЛЬНО: order уже validated
   * const validatedOrder = ...; // от ValidationPipeline
   * const result = await gateway.placeOrder(validatedOrder);
   *
   * // НЕПРАВИЛЬНО: не делайте так
   * const rawOrder = Order.create({ size: 100.567 }); // НЕ normalized
   * const result = await gateway.placeOrder(rawOrder); // ❌ Gateway не нормализует!
   * ```
   */
  placeOrder(order: Order): Promise<PlaceOrderResult>;

  /**
   * Отменяет ордер
   *
   * @param orderId - ID ордера для отмены
   * @returns CancelOrderResult
   *
   * @remarks
   * Отправляет запрос на отмену в CLOB.
   * Асинхронная операция - подтверждение может прийти через WebSocket.
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
   * ВАЖНО:
   * - Только PENDING/OPEN ордера могут быть отменены
   * - FILLED/CANCELLED ордера вернут ORDER_NOT_FOUND
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
  cancelOrder(orderId: string): Promise<CancelOrderResult>;

  /**
   * Получает все открытые ордера
   *
   * @param tokenId - Опциональный фильтр по tokenId
   * @returns GetOrdersResult
   *
   * @remarks
   * Запрашивает список открытых ордеров от биржи.
   *
   * Возвращает:
   * - Ok(Order[]): массив открытых ордеров (PENDING/OPEN)
   * - Err({ kind: 'FAILED', error: ExchangeError }): биржа отказала
   *
   * Фильтрация:
   * - Если tokenId указан → только ордера для этого токена
   * - Если tokenId не указан → все открытые ордера
   *
   * Возможные ExchangeError:
   * - RATE_LIMITED (429): слишком много requests
   * - AUTH_FAILED (401/403): invalid signature
   * - SERVER_ERROR (5xx): временная проблема биржи
   * - NETWORK_ERROR: timeout/connection
   * - FATAL: неизвестная ошибка
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
  getOpenOrders(tokenId?: string): Promise<GetOrdersResult>;
}
