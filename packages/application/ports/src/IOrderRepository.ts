/**
 * Порт: хранилище активных Order агрегатов.
 *
 * @remarks
 * Единственное определение — только в @polymarket/ports.
 * Handlers и use-cases импортируют отсюда.
 * Реализации: InMemoryOrderRepository (Phase 1), RedisOrderRepository (Phase 9).
 *
 * Используется:
 * - FillEventHandler — `get(orderId)` → применить fill
 * - OrderUpdateHandler — `get(orderId)` → обновить статус
 * - PlaceOrderUseCase — `save(order)` → сохранить новый ордер
 * - CancelOrderUseCase — `get()` / `delete()` → отмена ордера
 * - TradingAPI.getOpenOrders() — `getByStrategyId()`
 * - OrderRiskChecker — `countByStrategyId()` → O(1) проверка лимита
 */
import type { Order } from '@polymarket/order';
import type { OrderId } from '@polymarket/ids';

export interface IOrderRepository {
  /**
   * Возвращает Order по ID или undefined если не найден.
   *
   * @param orderId - ID ордера
   * @returns Promise с Order агрегатом или undefined
   */
  get(orderId: OrderId): Promise<Order | undefined>;

  /**
   * Сохраняет (или обновляет) Order агрегат.
   *
   * @param order - Order для сохранения
   * @returns Promise, завершающийся при успешном сохранении
   */
  save(order: Order): Promise<void>;

  /**
   * Удаляет Order из хранилища.
   *
   * @param orderId - ID ордера для удаления
   * @returns Promise, завершающийся при успешном удалении
   */
  delete(orderId: OrderId): Promise<void>;

  /**
   * Возвращает все открытые ордера стратегии.
   *
   * @param strategyId - ID стратегии
   * @returns Promise с readonly массивом ордеров стратегии
   *
   * @remarks
   * Используется TradingAPI.getOpenOrders().
   */
  getByStrategyId(strategyId: string): Promise<readonly Order[]>;

  /**
   * O(1) счётчик открытых ордеров.
   *
   * @param strategyId - ID стратегии (если undefined — все ордера)
   * @returns Promise с количеством открытых ордеров
   *
   * @remarks
   * Используется OrderRiskChecker для проверки лимита открытых ордеров.
   */
  countByStrategyId(strategyId?: string): Promise<number>;
}
