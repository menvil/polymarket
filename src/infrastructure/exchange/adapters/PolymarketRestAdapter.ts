/**
 * Polymarket REST Adapter - Facade для IExchangeAdapter
 *
 * @remarks
 * Facade адаптер для взаимодействия с Polymarket CLOB через REST API.
 * Реализует интерфейс IExchangeAdapter, делегируя в специализированные адаптеры.
 *
 * **Архитектура (после Step 3):**
 * ```
 * PolymarketRestAdapter (Facade)
 *   ├─ PolymarketExecutionAdapter (execution operations)
 *   │    ├─ CLOBClient
 *   │    ├─ MarketConstraintsPolicy
 *   │    ├─ BalancePolicy
 *   │    └─ WebSocketManager
 *   └─ PolymarketPortfolioAdapter (portfolio queries)
 *        ├─ BalanceRestClient
 *        ├─ PositionRestClient
 *        └─ OrderbookRestClient
 * ```
 *
 * Responsibilities:
 * - Implements IExchangeAdapter (Facade pattern)
 * - Делегирует execution операции в ExecutionAdapter
 * - Делегирует portfolio queries в PortfolioAdapter
 * - Обеспечивает backward compatibility
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketRestAdapter(
 *   executionAdapter,
 *   portfolioAdapter,
 *   logger
 * );
 *
 * // Execution delegation
 * const placedOrder = await adapter.placeOrder(order);
 *
 * // Portfolio delegation
 * const balance = await adapter.getBalance();
 * const orderbook = await adapter.getOrderBook('0xabc');
 * ```
 */

import { IExchangeAdapter } from '../../../domain/ports/IExchangeAdapter.js';
import { IExecutionAdapter } from '../../../domain/ports/IExecutionAdapter.js';
import { IPortfolioAdapter } from '../../../domain/ports/IPortfolioAdapter.js';
import { Order } from '../../../domain/entities/Order.js';
import { Orderbook } from '../../../domain/entities/Orderbook.js';
import { Money } from '../../../domain/value-objects/Money.js';
import { Quantity } from '../../../domain/value-objects/Quantity.js';
import { ILogger } from '../../../domain/ports/ILogger.js';

/**
 * Polymarket REST Adapter (Facade)
 *
 * @remarks
 * Комбинирует ExecutionAdapter + PortfolioAdapter.
 * Все методы делегируются в специализированные адаптеры.
 *
 * **Design Pattern: Facade**
 * - Упрощает взаимодействие с complex subsystems
 * - Обеспечивает backward compatibility с IExchangeAdapter
 * - Позволяет domain layer использовать один интерфейс
 */
export class PolymarketRestAdapter implements IExchangeAdapter {
  /**
   * Создаёт Polymarket REST Adapter (Facade)
   *
   * @param executionAdapter - Execution adapter (place/cancel orders, subscriptions)
   * @param portfolioAdapter - Portfolio adapter (balance, positions, orderbook)
   * @param logger - Логгер
   *
   * @example
   * ```typescript
   * const executionAdapter = new PolymarketExecutionAdapter(...);
   * const portfolioAdapter = new PolymarketPortfolioAdapter(...);
   *
   * const restAdapter = new PolymarketRestAdapter(
   *   executionAdapter,
   *   portfolioAdapter,
   *   logger
   * );
   * ```
   */
  constructor(
    private readonly executionAdapter: IExecutionAdapter,
    private readonly portfolioAdapter: IPortfolioAdapter,
    private readonly logger: ILogger
  ) {
    this.logger.debug('[PolymarketRestAdapter] Facade adapter initialized');
  }

  // ==========================================
  // Execution operations (delegated to ExecutionAdapter)
  // ==========================================

  /**
   * Размещает ордер на бирже
   *
   * @param order - Domain Order для размещения
   * @returns Размещённый ордер с обновлённым статусом
   * @throws {ExchangeError} При ошибке API
   * @throws {Error} При insufficient balance или invalid size
   *
   * @remarks
   * Делегирует в ExecutionAdapter.placeOrder()
   *
   * Full flow (в ExecutionAdapter):
   * 1. Normalize size via MarketConstraintsPolicy
   * 2. Check balance via BalancePolicy
   * 3. Place order via CLOBClient
   * 4. Learn from errors
   */
  public async placeOrder(order: Order): Promise<Order> {
    return this.executionAdapter.placeOrder(order);
  }

  /**
   * Отменяет ордер на бирже
   *
   * @param orderId - ID ордера для отмены
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Делегирует в ExecutionAdapter.cancelOrder()
   */
  public async cancelOrder(orderId: string): Promise<void> {
    return this.executionAdapter.cancelOrder(orderId);
  }

  /**
   * Получает все открытые ордера
   *
   * @param tokenId - Опциональный фильтр по tokenId
   * @returns Массив открытых ордеров
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Делегирует в ExecutionAdapter.getOpenOrders()
   */
  public async getOpenOrders(tokenId?: string): Promise<Order[]> {
    return this.executionAdapter.getOpenOrders(tokenId);
  }

  /**
   * Подписывается на обновления ордера
   *
   * @param orderId - ID ордера
   * @param callback - Функция обратного вызова при обновлении
   * @returns Функция для отписки
   *
   * @remarks
   * Делегирует в ExecutionAdapter.subscribeToOrderUpdates()
   */
  public subscribeToOrderUpdates(
    orderId: string,
    callback: (order: Order) => void
  ): () => void {
    return this.executionAdapter.subscribeToOrderUpdates(orderId, callback);
  }

  // ==========================================
  // Portfolio operations (delegated to PortfolioAdapter)
  // ==========================================

  /**
   * Получает текущий баланс USDC
   *
   * @returns Доступный баланс (available, не включает locked)
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Делегирует в PortfolioAdapter.getBalance()
   */
  public async getBalance(): Promise<Money> {
    return this.portfolioAdapter.getBalance();
  }

  /**
   * Получает текущую позицию по токену
   *
   * @param tokenId - ID токена (YES или NO)
   * @returns Количество токенов
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Делегирует в PortfolioAdapter.getPosition()
   */
  public async getPosition(tokenId: string): Promise<Quantity> {
    return this.portfolioAdapter.getPosition(tokenId);
  }

  /**
   * Получает стакан заявок для рынка
   *
   * @param marketId - ID рынка (tokenId)
   * @returns Orderbook snapshot
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Делегирует в PortfolioAdapter.getOrderBook()
   */
  public async getOrderBook(marketId: string): Promise<Orderbook> {
    return this.portfolioAdapter.getOrderBook(marketId);
  }

  /**
   * Получает все текущие позиции
   *
   * @returns Массив позиций (tokenId + quantity)
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Делегирует в PortfolioAdapter.getAllPositions()
   */
  public async getAllPositions(): Promise<Array<{ tokenId: string; quantity: Quantity }>> {
    return this.portfolioAdapter.getAllPositions();
  }

  /**
   * Получает locked (замороженный) баланс в открытых ордерах
   *
   * @returns Locked баланс USDC
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * Делегирует в PortfolioAdapter.getLockedBalance()
   */
  public async getLockedBalance(): Promise<Money> {
    return this.portfolioAdapter.getLockedBalance();
  }
}
