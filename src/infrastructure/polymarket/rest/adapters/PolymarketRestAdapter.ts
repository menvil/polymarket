/**
 * REST-адаптер Polymarket (Фасад)
 *
 * @remarks
 * Главная точка входа для операций REST API Polymarket.
 * Объединяет:
 * - ExecutionAdapter (API-вызовы)
 * - PortfolioAdapter (баланс, позиции)
 * - MarketConstraintsPolicy (обучение на ошибках)
 *
 * Предоставляет единую точку входа placeOrder() для внешнего кода.
 *
 * **Ключевой поток для placeOrder()**:
 * ```
 * 1. PortfolioAdapter.canPlaceOrder()
 *    → использует BalancePolicy + MarketConstraintsPolicy
 *    → возвращает {ok, normalizedSize}
 * 2. Если ok:
 *    ExecutionAdapter.postOrder(нормализованные параметры)
 *    → ТОЛЬКО выполняет HTTP POST, без валидации
 * 3. Возвращает orderId, status
 * 4. При ошибке: MarketConstraintsPolicy.learnFromError()
 * ```
 *
 * **Принципы**:
 * - placeOrder не проверяет баланс напрямую (делегирует политикам)
 * - ExecutionAdapter не решает валидность, только выполняет POST
 * - Логика повторов в MarketConstraintsPolicy + ExecutionAdapter, НЕ в фасаде
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketRestAdapter(
 *   executionAdapter,
 *   portfolioAdapter,
 *   constraintsPolicy,
 *   logger
 * );
 *
 * const order = await adapter.placeOrder({
 *   tokenId: '0x123',
 *   side: 'BUY',
 *   price: 0.52,
 *   size: 100,
 * });
 *
 * console.log(`Order placed: ${order.orderId}`);
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PlaceOrderParams, OrderResponse } from '../../../exchange/ports/IExecutionAdapter.js';
import type { PositionResponse } from '../../../exchange/ports/IPortfolioAdapter.js';
import type { PolymarketExecutionAdapter } from './PolymarketExecutionAdapter.js';
import type { PolymarketPortfolioAdapter } from './PolymarketPortfolioAdapter.js';
import type { PolymarketMarketConstraintsPolicy } from '../policies/PolymarketMarketConstraintsPolicy.js';
import { ApiError } from '../PolymarketRestClient.js';

/**
 * Ошибка валидации (выбрасывается когда ордер не может быть размещён)
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * REST-адаптер Polymarket (Фасад)
 *
 * @remarks
 * Главная точка входа для операций REST API.
 */
export class PolymarketRestAdapter {
  constructor(
    private readonly executionAdapter: PolymarketExecutionAdapter,
    private readonly portfolioAdapter: PolymarketPortfolioAdapter,
    private readonly constraintsPolicy: PolymarketMarketConstraintsPolicy,
    private readonly logger: ILogger
  ) {}

  /**
   * Получить адаптер исполнения (для передачи в StrategyContext)
   *
   * @returns Экземпляр адаптера исполнения
   *
   * @remarks
   * v7.6: StrategyContextImpl требует IExecutionAdapter, а не полный RestAdapter.
   * Используйте этот геттер для извлечения адаптера исполнения из фасада.
   */
  getExecutionAdapter(): PolymarketExecutionAdapter {
    return this.executionAdapter;
  }

  /**
   * Разместить ордер (главная точка входа)
   *
   * @param params - Параметры ордера
   * @returns Ответ с информацией об ордере
   * @throws {ValidationError} Если ордер не может быть размещён
   * @throws {ApiError} Если API-вызов не удался
   *
   * @remarks
   * Поток:
   * 1. PortfolioAdapter.canPlaceOrder() → использует политики → {ok, normalizedSize}
   * 2. Если ok: ExecutionAdapter.postOrder(нормализованные параметры)
   * 3. Возвращает orderId, status
   * 4. При ошибке: MarketConstraintsPolicy.learnFromError()
   *
   * @example
   * ```typescript
   * const order = await adapter.placeOrder({
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: 0.52,
   *   size: 100,
   * });
   *
   * console.log(`Order placed: ${order.orderId}`);
   * ```
   */
  async placeOrder(params: PlaceOrderParams): Promise<OrderResponse> {
    this.logger.info('placeOrder called', {
      tokenId: params.tokenId,
      side: params.side,
      price: params.price,
      size: params.size,
    });

    // Шаг 1: Проверить, может ли быть размещён ордер (использует политики)
    const canPlace = await this.portfolioAdapter.canPlaceOrder({
      tokenId: params.tokenId,
      side: params.side,
      price: params.price,
      size: params.size,
    });

    if (!canPlace.ok) {
      this.logger.warn('Order cannot be placed', {
        reason: canPlace.reason,
        tokenId: params.tokenId,
      });

      throw new ValidationError(canPlace.reason!);
    }

    this.logger.debug('Order validation passed', {
      normalizedSize: canPlace.normalizedSize,
      normalizedPrice: canPlace.normalizedPrice,
      priceTick: canPlace.priceTick,
    });

    // Шаг 2: Разместить ордер через ExecutionAdapter (ТОЛЬКО API-вызов)
    try {
      const order = await this.executionAdapter.postOrder({
        ...params,
        size: canPlace.normalizedSize!, // Использовать нормализованный размер
        price: canPlace.normalizedPrice!, // Использовать нормализованную цену (КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ)
        priceTick: canPlace.priceTick, // Передать priceTick в построитель API
        feeRateBps: canPlace.feeRateBps, // Передать изученную или стандартную ставку комиссии
      });

      this.logger.info('Order placed successfully', {
        orderId: order.orderId,
        status: order.status,
      });

      return order;
    } catch (error) {
      // Шаг 3: Обучиться на ошибке (если ошибка API содержит информацию об ограничениях)
      if (error instanceof ApiError) {
        this.constraintsPolicy.learnFromError(params.tokenId, error.message);

        this.logger.warn('Order placement failed, learned from error', {
          tokenId: params.tokenId,
          error: error.message,
        });
      }

      throw error;
    }
  }

  /**
   * Отменить ордер
   *
   * @param orderId - ID ордера для отмены
   * @throws {ApiError} Если API-вызов не удался
   *
   * @example
   * ```typescript
   * await adapter.cancelOrder('order-123');
   * console.log('Order cancelled');
   * ```
   */
  async cancelOrder(orderId: string): Promise<void> {
    this.logger.info('cancelOrder called', { orderId });

    await this.executionAdapter.cancelOrder(orderId);

    this.logger.info('Order cancelled successfully', { orderId });
  }

  /**
   * Получить открытые ордера
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив открытых ордеров
   * @throws {ApiError} Если API-вызов не удался
   *
   * @example
   * ```typescript
   * const orders = await adapter.getOpenOrders();
   * console.log(`Open orders: ${orders.length}`);
   * ```
   */
  async getOpenOrders(tokenId?: string): Promise<OrderResponse[]> {
    this.logger.debug('getOpenOrders called', { tokenId });

    const orders = await this.executionAdapter.getOpenOrders(tokenId);

    this.logger.debug('Open orders retrieved', {
      count: orders.length,
    });

    return orders;
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
   * console.log(`Order status: ${order.status}`);
   * ```
   */
  async getOrderById(orderId: string): Promise<{
    orderID: string;
    status: 'pending' | 'live' | 'filled' | 'cancelled';
    filledSize?: string;
    size?: string;
  }> {
    this.logger.debug('getOrderById called', { orderId });

    const order = await this.executionAdapter.getOrderById(orderId);

    this.logger.debug('Order retrieved', {
      orderId,
      status: order.status,
    });

    return order;
  }

  /**
   * Получить баланс
   *
   * @returns Доступный баланс USDC
   * @throws {ApiError} Если API-вызов не удался
   *
   * @example
   * ```typescript
   * const balance = await adapter.getBalance();
   * console.log(`Balance: ${balance} USDC`);
   * ```
   */
  async getBalance(): Promise<number> {
    this.logger.debug('getBalance called');

    const balance = await this.portfolioAdapter.getBalance();

    this.logger.debug('Balance retrieved', { balance });

    return balance;
  }

  /**
   * Получить баланс исхода
   *
   * @param tokenId - ID токена
   * @returns Баланс токена исхода
   * @throws {ApiError} Если API-вызов не удался
   *
   * @example
   * ```typescript
   * const balance = await adapter.getOutcomeBalance('0x123');
   * console.log(`Outcome balance: ${balance}`);
   * ```
   */
  async getOutcomeBalance(tokenId: string): Promise<number> {
    this.logger.debug('getOutcomeBalance called', { tokenId });

    const balance = await this.portfolioAdapter.getOutcomeBalance(tokenId);

    this.logger.debug('Outcome balance retrieved', {
      tokenId,
      balance,
    });

    return balance;
  }

  /**
   * Получить позиции
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив позиций
   * @throws {ApiError} Если API-вызов не удался
   *
   * @example
   * ```typescript
   * const positions = await adapter.getPositions();
   * console.log(`Positions: ${positions.length}`);
   * ```
   */
  async getPositions(tokenId?: string): Promise<PositionResponse[]> {
    // v7.7.14: Удалены дублирующиеся логи (логируется в нижних слоях)
    const positions = await this.portfolioAdapter.getPositions(tokenId);
    return positions;
  }

  /**
   * Одобрить USDC для торговли
   *
   * @param amount - Сумма для одобрения
   * @throws {BlockchainError} Если вызов блокчейна не удался
   *
   * @example
   * ```typescript
   * await adapter.approveUSDC(1000);
   * console.log('USDC approved');
   * ```
   */
  async approveUSDC(amount: number): Promise<void> {
    this.logger.info('approveUSDC called', { amount });

    await this.portfolioAdapter.approveUSDC(amount);

    this.logger.info('USDC approved', { amount });
  }

  /**
   * Получить ограничения рынка (реализует IMarketConstraintsProvider)
   *
   * @param tokenId - ID токена или слаг рынка
   * @returns Ограничения рынка (minOrderSize, sizeTick, priceTick и т.д.)
   *
   * @remarks
   * КРИТИЧНО для StrategyFactory! Используется для получения minOrderSize из рынка.
   *
   * Делегирует в PolymarketMarketConstraintsPolicy, который:
   * 1. Проверяет кэш
   * 2. Получает из API при необходимости
   * 3. Возвращает безопасные значения по умолчанию при ошибке
   *
   * @example
   * ```typescript
   * const constraints = await adapter.getConstraints('0x123');
   * console.log(`Min size: ${constraints.minOrderSize}`);
   * ```
   */
  async getConstraints(tokenIdOrSlug: string): Promise<{
    minOrderSize: number;
    maxOrderSize: number;
    sizeTick: number;
    priceTick: number;
    minOrderValue: number;
  }> {
    this.logger.debug('getConstraints called', { tokenIdOrSlug });

    const constraints = await this.constraintsPolicy.getConstraints(tokenIdOrSlug);

    this.logger.debug('Constraints retrieved', {
      tokenIdOrSlug,
      constraints,
    });

    return constraints;
  }

  /**
   * Очистить кэш ограничений
   *
   * @param tokenId - Опционально: очистить для конкретного токена, или все, если не указано
   *
   * @remarks
   * Принудительно перезагрузить ограничения при следующем доступе.
   * Полезно после изменения параметров рынка.
   *
   * @example
   * ```typescript
   * adapter.clearConstraintsCache('0x123');
   * adapter.clearConstraintsCache(); // Очистить все
   * ```
   */
  clearConstraintsCache(tokenId?: string): void {
    if (tokenId) {
      this.constraintsPolicy.clearCache(tokenId);
      this.logger.info('Cleared constraints cache for token', { tokenId });
    } else {
      this.constraintsPolicy.clearAllCache();
      this.logger.info('Cleared all constraints cache');
    }
  }
}
