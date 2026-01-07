/**
 * IExchangeAdapter port
 *
 * @remarks
 * Facade интерфейс для взаимодействия с биржей (Polymarket CLOB).
 * Комбинирует IExecutionAdapter + IPortfolioAdapter для backward compatibility.
 *
 * **Архитектура (Step 3):**
 * - IExecutionAdapter - execution операции (place/cancel orders, subscriptions)
 * - IPortfolioAdapter - portfolio queries (balance, positions, orderbook)
 * - IExchangeAdapter - facade (объединяет оба интерфейса)
 *
 * Реализация находится в infrastructure layer.
 *
 * @example
 * ```typescript
 * // Facade реализация
 * class PolymarketRestAdapter implements IExchangeAdapter {
 *   constructor(
 *     private executionAdapter: IExecutionAdapter,
 *     private portfolioAdapter: IPortfolioAdapter
 *   ) {}
 *
 *   async placeOrder(order: Order) {
 *     return this.executionAdapter.placeOrder(order);
 *   }
 *
 *   async getBalance() {
 *     return this.portfolioAdapter.getBalance();
 *   }
 * }
 * ```
 */
import { IExecutionAdapter } from './IExecutionAdapter.js';
import { IPortfolioAdapter } from './IPortfolioAdapter.js';

/**
 * Exchange adapter interface (Facade)
 *
 * @remarks
 * Комбинирует execution + portfolio операции.
 * Domain layer использует этот интерфейс для backward compatibility.
 *
 * **Migration path:**
 * 1. Step 3: Создаём IExecutionAdapter + IPortfolioAdapter
 * 2. IExchangeAdapter extends оба интерфейса (facade)
 * 3. Existing code продолжает работать через IExchangeAdapter
 * 4. New code может использовать IExecutionAdapter / IPortfolioAdapter напрямую
 */
export interface IExchangeAdapter extends IExecutionAdapter, IPortfolioAdapter {
  // Facade interface - все методы наследуются от:
  // - IExecutionAdapter: placeOrder, cancelOrder, getOpenOrders, subscribeToOrderUpdates
  // - IPortfolioAdapter: getBalance, getPosition, getOrderBook, getAllPositions, getLockedBalance
}
