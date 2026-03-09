/**
 * Polymarket REST Adapter (Facade)
 *
 * @remarks
 * Main entry point for Polymarket REST API operations.
 * Combines:
 * - ExecutionAdapter (API calls)
 * - PortfolioAdapter (balance, positions)
 * - MarketConstraintsPolicy (learning from errors)
 *
 * Provides single placeOrder() entry point for external code.
 *
 * **Key flow for placeOrder()**:
 * ```
 * 1. PortfolioAdapter.canPlaceOrder()
 *    → uses BalancePolicy + MarketConstraintsPolicy
 *    → returns {ok, normalizedSize}
 * 2. If ok:
 *    ExecutionAdapter.postOrder(normalized params)
 *    → ONLY does HTTP POST, no validation
 * 3. Returns orderId, status
 * 4. If error: MarketConstraintsPolicy.learnFromError()
 * ```
 *
 * **Principles**:
 * - placeOrder doesn't check balance inline (delegates to policies)
 * - ExecutionAdapter doesn't decide validity, just executes POST
 * - Retry logic in MarketConstraintsPolicy + ExecutionAdapter, NOT facade
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
 *   side: 'buy',
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
 * Validation error (thrown when order cannot be placed)
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Polymarket REST Adapter (Facade)
 *
 * @remarks
 * Main entry point for REST API operations.
 */
export class PolymarketRestAdapter {
  constructor(
    private readonly executionAdapter: PolymarketExecutionAdapter,
    private readonly portfolioAdapter: PolymarketPortfolioAdapter,
    private readonly constraintsPolicy: PolymarketMarketConstraintsPolicy,
    private readonly logger: ILogger
  ) {}

  /**
   * Get execution adapter (for passing to StrategyContext)
   *
   * @returns Execution adapter instance
   *
   * @remarks
   * v7.6: StrategyContextImpl requires IExecutionAdapter, not the full RestAdapter.
   * Use this getter to extract the execution adapter from the facade.
   */
  getExecutionAdapter(): PolymarketExecutionAdapter {
    return this.executionAdapter;
  }

  /**
   * Place order (main entry point)
   *
   * @param params - Order parameters
   * @returns Order response
   * @throws {ValidationError} If order cannot be placed
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Flow:
   * 1. PortfolioAdapter.canPlaceOrder() → uses policies → {ok, normalizedSize}
   * 2. If ok: ExecutionAdapter.postOrder(normalized params)
   * 3. Returns orderId, status
   * 4. If error: MarketConstraintsPolicy.learnFromError()
   *
   * @example
   * ```typescript
   * const order = await adapter.placeOrder({
   *   tokenId: '0x123',
   *   side: 'buy',
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

    // Шаг 1: Проверяем возможность размещения ордера (используем политики)
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

    // Шаг 2: Размещаем ордер через ExecutionAdapter (ТОЛЬКО API вызов)
    try {
      const order = await this.executionAdapter.postOrder({
        ...params,
        size: canPlace.normalizedSize!, // Используем нормализованный размер
        price: canPlace.normalizedPrice!, // Используем нормализованную цену
        priceTick: canPlace.priceTick, // Передаём шаг цены в построитель API
        feeRateBps: canPlace.feeRateBps, // Передаём изученную или дефолтную ставку комиссии
      });

      this.logger.info('Order placed successfully', {
        orderId: order.orderId,
        status: order.status,
      });

      return order;
    } catch (error) {
      // Шаг 3: Обучаемся на ошибке (если API-ошибка содержит информацию об ограничениях)
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
   * Cancel order
   *
   * @param orderId - Order ID to cancel
   * @throws {ApiError} If API call fails
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
   * Get open orders
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of open orders
   * @throws {ApiError} If API call fails
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
   * Get balance
   *
   * @returns Available USDC balance
   * @throws {ApiError} If API call fails
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
   * Get outcome balance
   *
   * @param tokenId - Token ID
   * @returns Outcome token balance
   * @throws {ApiError} If API call fails
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
   * Get positions
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of positions
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const positions = await adapter.getPositions();
   * console.log(`Positions: ${positions.length}`);
   * ```
   */
  async getPositions(tokenId?: string): Promise<PositionResponse[]> {
    // Дублирующие логи удалены (логируются в нижних слоях)
    const positions = await this.portfolioAdapter.getPositions(tokenId);
    return positions;
  }

  /**
   * Approve USDC for trading
   *
   * @param amount - Amount to approve
   * @throws {BlockchainError} If blockchain call fails
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
   * Get market constraints (implements IMarketConstraintsProvider)
   *
   * @param tokenId - Token ID or market slug
   * @returns Market constraints (minOrderSize, sizeTick, priceTick, etc.)
   *
   * @remarks
   * КРИТИЧНО для StrategyFactory! Используется для получения minOrderSize из маркета.
   *
   * Delegates to PolymarketMarketConstraintsPolicy which:
   * 1. Checks cache
   * 2. Fetches from API if needed
   * 3. Returns safe defaults on error
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
   * Clear constraints cache
   *
   * @param tokenId - Optional: clear specific token, or all if not specified
   *
   * @remarks
   * Forces re-fetch of constraints on next access.
   * Useful after market parameters change.
   *
   * @example
   * ```typescript
   * adapter.clearConstraintsCache('0x123');
   * adapter.clearConstraintsCache(); // Clear all
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
