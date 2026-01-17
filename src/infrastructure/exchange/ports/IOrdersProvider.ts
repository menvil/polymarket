/**
 * Общий интерфейс провайдера ордеров (МНОЖЕСТВЕННОЕ ЧИСЛО!)
 *
 * @remarks
 * Провайдер ордеров абстрагирует доступ к данным об ордерах.
 * Предоставляет доступ только для чтения к открытым ордерам и истории ордеров.
 *
 * **ВАЖНО**: Это множественное число "Orders" (не единственное "Order"),
 * потому что он управляет несколькими ордерами.
 *
 * **ПРИМЕЧАНИЕ**: Этот провайдер предназначен только для чтения. Для размещения/отмены ордеров
 * используйте IExecutionAdapter.
 *
 * **Варианты использования**:
 * - Получение открытых ордеров
 * - Получение ордера по ID
 * - Получение истории ордеров
 * - Мониторинг статуса ордеров
 *
 * @example
 * ```typescript
 * const provider = new PolymarketOrdersProvider(orderClient, mapper, logger);
 *
 * const openOrders = await provider.getOpenOrders();
 * console.log(`Открытые ордера: ${openOrders.length}`);
 *
 * const order = await provider.getOrderById('order-123');
 * console.log(`Статус ордера: ${order.status}`);
 * ```
 */

import type { OrderResponse, OrderStatus } from '../types/OrderResponse.js';

export type { OrderResponse, OrderStatus };

/**
 * Общий интерфейс провайдера ордеров (МНОЖЕСТВЕННОЕ ЧИСЛО!)
 */
export interface IOrdersProvider {
  /**
   * Получить все открытые ордера
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив открытых ордеров
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Возвращает только ордера со статусом 'open' или 'partially_filled'.
   * Исполненные и отменённые ордера исключены.
   *
   * @example
   * ```typescript
   * const openOrders = await provider.getOpenOrders();
   * console.log(`Открытые ордера: ${openOrders.length}`);
   *
   * const btcOrders = await provider.getOpenOrders('BTC-USD');
   * console.log(`Открытые ордера BTC: ${btcOrders.length}`);
   * ```
   */
  getOpenOrders(tokenId?: string): Promise<OrderResponse[]>;

  /**
   * Получить конкретный ордер по ID
   *
   * @param orderId - ID ордера
   * @returns Ответ с ордером
   * @throws {ApiError} Если вызов API завершился неудачей или ордер не найден
   *
   * @example
   * ```typescript
   * const order = await provider.getOrderById('order-123');
   * console.log(`Статус ордера: ${order.status}`);
   * console.log(`Осталось: ${order.sizeRemaining}`);
   * ```
   */
  getOrderById(orderId: string): Promise<OrderResponse>;

  /**
   * Получить историю ордеров (исполненные и отменённые)
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @param limit - Опционально: максимальное количество ордеров для возврата
   * @returns Массив исторических ордеров
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Опциональный метод. Возвращает исполненные и отменённые ордера.
   *
   * @example
   * ```typescript
   * const history = await provider.getOrderHistory('0x123', 100);
   * console.log(`Последние 100 ордеров для токена 0x123: ${history.length}`);
   * ```
   */
  getOrderHistory?(tokenId?: string, limit?: number): Promise<OrderResponse[]>;

  /**
   * Получить ордера по статусу
   *
   * @param status - Статус ордера для фильтрации
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив ордеров с указанным статусом
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Опциональный метод. Возвращает ордера отфильтрованные по статусу.
   *
   * @example
   * ```typescript
   * const filledOrders = await provider.getOrdersByStatus('filled');
   * console.log(`Исполненные ордера: ${filledOrders.length}`);
   * ```
   */
  getOrdersByStatus?(
    status: 'open' | 'partially_filled' | 'filled' | 'cancelled',
    tokenId?: string
  ): Promise<OrderResponse[]>;
}