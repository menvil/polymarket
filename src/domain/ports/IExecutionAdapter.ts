/**
 * IExecutionAdapter port
 *
 * @remarks
 * Интерфейс для execution операций (размещение/отмена ордеров).
 * Часть разделения IExchangeAdapter на Execution и Portfolio (Step 3).
 *
 * Responsibilities:
 * - Размещение ордеров (с нормализацией и валидацией)
 * - Отмена ордеров
 * - Получение открытых ордеров
 * - Подписка на обновления ордеров
 *
 * Не включает:
 * - Portfolio queries (getBalance, getPosition)
 * - Market data (getOrderBook)
 *
 * @example
 * ```typescript
 * class PolymarketExecutionAdapter implements IExecutionAdapter {
 *   async placeOrder(order: Order): Promise<Order> {
 *     // 1. Normalize size via MarketConstraintsPolicy
 *     // 2. Check balance via BalancePolicy
 *     // 3. Place order via CLOBClient
 *     // 4. Learn from errors
 *     return placedOrder;
 *   }
 * }
 * ```
 */
import { Order } from '../entities/Order.js';

/**
 * Execution adapter interface
 *
 * @remarks
 * Domain layer не зависит от конкретной реализации execution.
 * Infrastructure layer предоставляет реализацию (Polymarket, другие биржи).
 */
export interface IExecutionAdapter {
  /**
   * Размещает ордер на бирже
   *
   * @param order - Ордер для размещения
   * @returns Обновлённый ордер с биржевым ID и статусом
   * @throws {ExchangeError} При ошибке API
   * @throws {Error} При insufficient balance или invalid size
   *
   * @remarks
   * Алгоритм:
   * 1. Нормализует размер ордера (округление по sizeTick, min/max validation)
   * 2. Проверяет баланс (USDC для BUY, outcome tokens для SELL)
   * 3. Отправляет ордер в CLOB
   * 4. Обучается из ошибок (learnFromError для constraints)
   * 5. Возвращает ордер с обновлённым статусом (PENDING -> OPEN)
   *
   * @example
   * ```typescript
   * const order = Order.create({
   *   tokenId: '0xabc',
   *   side: 'BUY',
   *   price: Price.fromNumber(0.55),
   *   size: Quantity.fromNumber(100),
   *   status: 'PENDING'
   * });
   *
   * const placedOrder = await executionAdapter.placeOrder(order);
   * console.log(placedOrder.status); // 'OPEN'
   * ```
   */
  placeOrder(order: Order): Promise<Order>;

  /**
   * Отменяет ордер на бирже
   *
   * @param orderId - ID ордера для отмены
   * @returns void
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * - Отправляет запрос на отмену в CLOB
   * - Асинхронная операция (подтверждение может прийти через WebSocket)
   * - Только PENDING или OPEN ордера могут быть отменены
   *
   * @example
   * ```typescript
   * await executionAdapter.cancelOrder('0x123abc');
   * console.log('Cancel request sent');
   * ```
   */
  cancelOrder(orderId: string): Promise<void>;

  /**
   * Получает все открытые ордера
   *
   * @param tokenId - Опциональный фильтр по tokenId
   * @returns Массив открытых ордеров
   * @throws {ExchangeError} При ошибке API
   *
   * @remarks
   * - Возвращает только PENDING и OPEN ордера
   * - Если tokenId указан → фильтрует только по этому токену
   * - Если tokenId не указан → все открытые ордера
   *
   * @example
   * ```typescript
   * // Все открытые ордера
   * const allOrders = await executionAdapter.getOpenOrders();
   * console.log(`Total open orders: ${allOrders.length}`);
   *
   * // Только для конкретного токена
   * const tokenOrders = await executionAdapter.getOpenOrders('0xabc');
   * console.log(`Open orders for token: ${tokenOrders.length}`);
   * ```
   */
  getOpenOrders(tokenId?: string): Promise<Order[]>;

  /**
   * Подписывается на обновления ордера
   *
   * @param orderId - ID ордера
   * @param callback - Функция обратного вызова при обновлении
   * @returns Функция для отписки
   *
   * @remarks
   * - Слушает WebSocket для обновлений статуса ордера
   * - Вызывает callback при каждом изменении (PENDING -> OPEN -> FILLED)
   * - Возвращает unsubscribe функцию для отписки
   *
   * Lifecycle:
   * 1. PENDING (ордер создан локально)
   * 2. OPEN (ордер принят биржей)
   * 3. FILLED / PARTIALLY_FILLED (ордер исполнен)
   * 4. CANCELLED / REJECTED (ордер отменён/отклонён)
   *
   * @example
   * ```typescript
   * const unsubscribe = executionAdapter.subscribeToOrderUpdates(
   *   '0x123abc',
   *   (order) => {
   *     console.log(`Order ${order.id} updated: ${order.status}`);
   *     if (order.status === 'FILLED') {
   *       console.log('Order filled!');
   *       unsubscribe();
   *     }
   *   }
   * );
   *
   * // Отписаться вручную
   * // unsubscribe();
   * ```
   */
  subscribeToOrderUpdates(
    orderId: string,
    callback: (order: Order) => void
  ): () => void;
}
