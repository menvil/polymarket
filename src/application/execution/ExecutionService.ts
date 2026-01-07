/**
 * ExecutionService - КООРДИНАТОР execution pipeline (БЕЗ decision logic)
 *
 * @remarks
 * ExecutionService координирует execution flow:
 * Order Intent → Normalize → Validate → Execute → Result
 *
 * КРИТИЧЕСКИ ВАЖНО - ExecutionService это КООРДИНАТОР:
 * ✅ Координирует вызовы компонентов (pipeline orchestration)
 * ✅ Преобразует между слоями (Domain ↔ Infrastructure)
 * ✅ Логирует execution flow (observability)
 * ✅ Возвращает PlaceOrderResult (REJECTED или FAILED)
 *
 * ❌ НЕТ decision logic (это Decision Layer)
 * ❌ НЕТ retry strategies (это upstream responsibility)
 * ❌ НЕТ multi-exchange routing (это upstream responsibility)
 * ❌ НЕТ throttling/batching (это upstream responsibility)
 * ❌ НЕТ circuit breaker (это upstream responsibility)
 *
 * Алгоритм placeOrder():
 * 1. Получить ValidationContext (ValidationContextProvider.getContext)
 * 2. Normalize order intent (IntentNormalizer.normalize)
 *    - Логировать diff если был normalized
 * 3. Validate normalized order (ValidationPipeline.validate)
 *    - Если validation failed → return Err(REJECTED)
 * 4. Place order через gateway (ITradingGateway.placeOrder)
 *    - Если gateway failed → return Err(FAILED)
 * 5. Return Ok(Order)
 *
 * BOUNDARY (ГРАНИЦА):
 * ExecutionService - это ПОСЛЕДНИЙ слой Application Layer.
 * ВЫШЕ ExecutionService - Decision Layer (стратегии, meta-strategies).
 * НИЖЕ ExecutionService - Infrastructure Layer (HTTP, database, async IO).
 *
 * КОГДА РЕФАКТОРИТЬ:
 * - Если появляется retry logic → создать RetryPolicy ВЫШЕ ExecutionService
 * - Если появляется multi-exchange → создать ExchangeRouter ВЫШЕ ExecutionService
 * - Если появляется throttling → создать ThrottlingPolicy ВЫШЕ ExecutionService
 *
 * @example
 * ```typescript
 * // Production usage
 * const executionService = new ExecutionService(
 *   normalizer,
 *   validationPipeline,
 *   contextProvider,
 *   tradingGateway,
 *   logger
 * );
 *
 * // Strategy (Decision Layer) использует ExecutionService
 * const orderIntent = Order.create({
 *   id: generateId(),
 *   tokenId: 'token-yes',
 *   side: 'BUY',
 *   price: Price.fromNumber(0.567), // НЕ normalized
 *   size: Quantity.fromNumber(100.123), // НЕ normalized
 *   status: 'PENDING',
 *   timestamp: new Date(),
 * });
 *
 * const result = await executionService.placeOrder(orderIntent);
 *
 * // Strategy ДОЛЖЕН обработать result
 * if (!result.ok) {
 *   if (result.error.kind === 'REJECTED') {
 *     // Локальная ошибка - strategy decision
 *     strategy.handleRejection(result.error.error);
 *   } else if (result.error.kind === 'FAILED') {
 *     // Внешняя ошибка - strategy decision
 *     strategy.handleExchangeError(result.error.error);
 *   }
 * }
 * ```
 */

import type { Order } from '../../domain/entities/Order.js';
import type { PlaceOrderResult, CancelOrderResult, GetOrdersResult } from '../../domain/types/ExecutionResult.js';
import type { ITradingGateway } from '../../domain/ports/ITradingGateway.js';
import type { ILogger } from '../../domain/ports/ILogger.js';
import { IntentNormalizer } from './IntentNormalizer.js';
import { ValidationPipeline } from './ValidationPipeline.js';
import { ValidationContextProvider } from './ValidationContextProvider.js';
import { Err } from '../../shared/types/Result.js';
import { ExchangeErrorCode } from '../../domain/types/ExchangeError.js';

/**
 * ExecutionService - координатор execution pipeline
 *
 * @remarks
 * Stateful класс (хранит dependencies).
 * НЕ хранит бизнес-логику (только координация).
 */
export class ExecutionService {
  /**
   * Создаёт ExecutionService
   *
   * @param intentNormalizer - Нормализует order intent (чистая функция)
   * @param validationPipeline - Валидирует order (чистая функция)
   * @param contextProvider - Получает ValidationContext (делает IO)
   * @param tradingGateway - Gateway для размещения ордеров (делает HTTP)
   * @param logger - Logger для structured logging
   *
   * @remarks
   * Dependencies:
   * - IntentNormalizer: чистая функция (NO IO)
   * - ValidationPipeline: чистая функция (NO IO)
   * - ValidationContextProvider: делает IO (HTTP, async state)
   * - ITradingGateway: делает HTTP (exchange API)
   * - ILogger: structured logging (observability)
   *
   * ВАЖНО:
   * ExecutionService НЕ создаёт dependencies (Dependency Injection).
   * Это позволяет подменить implementation (backtest, simulation, tests).
   *
   * @example
   * ```typescript
   * // Production
   * const executionService = new ExecutionService(
   *   new IntentNormalizer(),
   *   new ValidationPipeline(logger),
   *   new ValidationContextProvider(marketPolicy, balanceProvider, positionProvider, logger),
   *   new PolymarketTradingGateway(clobClient, logger),
   *   logger
   * );
   *
   * // Backtest (подменить gateway на BacktestGateway)
   * const backtestExecutionService = new ExecutionService(
   *   new IntentNormalizer(),
   *   new ValidationPipeline(logger),
   *   new BacktestContextProvider(backtestData),
   *   new BacktestGateway(backtestData),
   *   logger
   * );
   * ```
   */
  constructor(
    private readonly intentNormalizer: IntentNormalizer,
    private readonly validationPipeline: ValidationPipeline,
    private readonly contextProvider: ValidationContextProvider,
    private readonly tradingGateway: ITradingGateway,
    private readonly logger: ILogger
  ) {}

  /**
   * Размещает ордер через execution pipeline
   *
   * @param orderIntent - Order intent от стратегии (может быть НЕ normalized)
   * @returns PlaceOrderResult (Ok, REJECTED, или FAILED)
   *
   * @remarks
   * ПОЛНЫЙ EXECUTION PIPELINE:
   * 1. Получить ValidationContext (IO: HTTP, async state)
   * 2. Normalize order intent (pure function)
   * 3. Validate normalized order (pure function)
   * 4. Place order через gateway (IO: HTTP)
   *
   * Возвращает:
   * - Ok(Order): ордер размещён успешно
   * - Err({ kind: 'REJECTED', error: ValidationError }): локальная validation failed
   * - Err({ kind: 'FAILED', error: ExchangeError }): биржа отказала
   *
   * ВАЖНО:
   * - REJECTED = "стратегия ошиблась" (intent был неправильный)
   * - FAILED = "мир сломан" (биржа/сеть не работает)
   *
   * Decision Layer ДОЛЖЕН обрабатывать оба случая по-разному.
   *
   * Алгоритм (детально):
   *
   * Step 1: Получить ValidationContext
   * - Параллельные HTTP запросы (market constraints, balance, position)
   * - Если IO failed → fallback на default values (см. ValidationContextProvider)
   *
   * Step 2: Normalize order intent
   * - Округлить size по sizeTick (banker's rounding)
   * - Округлить price по priceTick (banker's rounding)
   * - Вернуть NormalizationResult с diff
   * - Логировать diff если был normalized
   *
   * Step 3: Validate normalized order
   * - Проверить size constraints (min/max)
   * - Проверить price constraints (min/max)
   * - Проверить balance (USDC для BUY, tokens для SELL)
   * - Проверить position limits (risk management)
   * - Если validation failed → return Err(REJECTED)
   *
   * Step 4: Place order через gateway
   * - Domain Order → API params (OrderMapper.toApi)
   * - HTTP POST /order (CLOBClient.placeOrder)
   * - API response → Domain Order (OrderMapper.fromApi)
   * - Если HTTP failed → return Err(FAILED)
   *
   * Step 5: Return result
   * - Ok(Order): успешно размещён
   * - Err(REJECTED): не прошёл validation
   * - Err(FAILED): биржа отказала
   *
   * @example
   * ```typescript
   * // Strategy creates order intent (НЕ normalized)
   * const orderIntent = Order.create({
   *   id: generateId(),
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   price: Price.fromNumber(0.567), // Будет rounded → 0.57
   *   size: Quantity.fromNumber(100.123), // Будет rounded → 100.12
   *   status: 'PENDING',
   *   timestamp: new Date(),
   * });
   *
   * // ExecutionService координирует весь pipeline
   * const result = await executionService.placeOrder(orderIntent);
   *
   * // Strategy обрабатывает result
   * if (result.ok) {
   *   console.log('Order placed:', result.value.id);
   * } else if (result.error.kind === 'REJECTED') {
   *   console.error('Validation failed:', result.error.error.type);
   * } else if (result.error.kind === 'FAILED') {
   *   console.error('Exchange failed:', result.error.error.type);
   * }
   * ```
   */
  public async placeOrder(orderIntent: Order): Promise<PlaceOrderResult> {
    this.logger.info('[ExecutionService] Starting order placement', {
      orderId: orderIntent.id,
      tokenId: orderIntent.tokenId.substring(0, 16) + '...',
      side: orderIntent.side,
      price: orderIntent.price.value,
      size: orderIntent.size.value,
    });

    try {
      // Step 1: Получить ValidationContext (IO)
      const context = await this.contextProvider.getContext(orderIntent.tokenId);

      this.logger.debug('[ExecutionService] ValidationContext obtained', {
        balance: context.balance.toFixed(2),
        minOrderSize: context.marketConstraints.minOrderSize,
        maxOrderSize: context.marketConstraints.maxOrderSize,
      });

      // Step 2: Normalize order intent (pure function)
      const normalizationResult = this.intentNormalizer.normalize(
        orderIntent,
        context.marketConstraints
      );

      if (normalizationResult.wasNormalized && normalizationResult.diff) {
        this.logger.info('[ExecutionService] Order intent normalized', {
          originalSize: normalizationResult.diff.originalSize,
          normalizedSize: normalizationResult.diff.normalizedSize,
          originalPrice: normalizationResult.diff.originalPrice,
          normalizedPrice: normalizationResult.diff.normalizedPrice,
        });
      }

      const normalizedOrder = normalizationResult.order;

      // Step 3: Validate normalized order (pure function)
      const validationResult = this.validationPipeline.validate(normalizedOrder, context);

      if (!validationResult.ok) {
        this.logger.warn('[ExecutionService] Order validation failed', {
          orderId: normalizedOrder.id,
          errorType: validationResult.error.type,
          errorCode: validationResult.error.code,
        });

        // Return REJECTED (локальная ошибка)
        return Err({
          kind: 'REJECTED',
          error: validationResult.error,
        });
      }

      this.logger.debug('[ExecutionService] Order validation passed', {
        orderId: normalizedOrder.id,
      });

      // Step 4: Place order через gateway (IO: HTTP)
      const placementResult = await this.tradingGateway.placeOrder(normalizedOrder);

      if (!placementResult.ok) {
        this.logger.error('[ExecutionService] Order placement failed', {
          orderId: normalizedOrder.id,
          errorKind: placementResult.error.kind,
          errorType: placementResult.error.error?.type,
        });

        // Return FAILED (внешняя ошибка)
        return placementResult; // Уже Err(FAILED)
      }

      this.logger.info('[ExecutionService] Order placed successfully', {
        orderId: placementResult.value.id,
        status: placementResult.value.status,
      });

      // Return Ok(Order)
      return placementResult;
    } catch (error) {
      // Unexpected error (не должно происходить, но на всякий случай)
      this.logger.error('[ExecutionService] Unexpected error during order placement', {
        orderId: orderIntent.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Маппим в FATAL ExchangeError
      return Err({
        kind: 'FAILED',
        error: {
          type: 'FATAL',
          code: ExchangeErrorCode.FATAL,
          httpStatus: 0,
          message: error instanceof Error ? error.message : String(error),
          requiresManualInvestigation: true,
        },
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
   * Простой pass-through к gateway (без validation).
   *
   * Алгоритм:
   * 1. Log начала операции
   * 2. Вызвать gateway.cancelOrder(orderId)
   * 3. Вернуть result
   *
   * Validation НЕ НУЖНА (нечего валидировать).
   * Gateway сам обработает ошибки (ORDER_NOT_FOUND, etc).
   *
   * @example
   * ```typescript
   * const result = await executionService.cancelOrder('0x123abc');
   *
   * if (result.ok) {
   *   console.log('Order cancelled');
   * } else {
   *   console.error('Cancel failed:', result.error.error.type);
   * }
   * ```
   */
  public async cancelOrder(orderId: string): Promise<CancelOrderResult> {
    this.logger.info('[ExecutionService] Cancelling order', {
      orderId: orderId.substring(0, 16) + '...',
    });

    const result = await this.tradingGateway.cancelOrder(orderId);

    if (result.ok) {
      this.logger.info('[ExecutionService] Order cancelled successfully', {
        orderId: orderId.substring(0, 16) + '...',
      });
    } else {
      this.logger.error('[ExecutionService] Order cancellation failed', {
        orderId: orderId.substring(0, 16) + '...',
        errorType: result.error.error.type,
      });
    }

    return result;
  }

  /**
   * Получает все открытые ордера
   *
   * @param tokenId - Опциональный фильтр по tokenId
   * @returns GetOrdersResult (Ok(Order[]) или Err(FAILED))
   *
   * @remarks
   * Простой pass-through к gateway (без validation).
   *
   * Алгоритм:
   * 1. Log начала операции
   * 2. Вызвать gateway.getOpenOrders(tokenId)
   * 3. Вернуть result
   *
   * @example
   * ```typescript
   * // Все открытые ордера
   * const result = await executionService.getOpenOrders();
   * if (result.ok) {
   *   console.log(`Found ${result.value.length} open orders`);
   * }
   *
   * // Ордера для конкретного токена
   * const result = await executionService.getOpenOrders('0x123...');
   * ```
   */
  public async getOpenOrders(tokenId?: string): Promise<GetOrdersResult> {
    this.logger.info('[ExecutionService] Fetching open orders', {
      tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
    });

    const result = await this.tradingGateway.getOpenOrders(tokenId);

    if (result.ok) {
      this.logger.info('[ExecutionService] Open orders fetched successfully', {
        count: result.value.length,
        tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      });
    } else {
      this.logger.error('[ExecutionService] Failed to fetch open orders', {
        tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
        errorType: result.error.error.type,
      });
    }

    return result;
  }
}
