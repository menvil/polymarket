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
   * @returns Order агрегат или undefined
   */
  get(orderId: OrderId): Order | undefined;

  /**
   * Сохраняет (или обновляет) Order агрегат.
   *
   * @param order - Order для сохранения
   */
  save(order: Order): void;

  /**
   * Удаляет Order из хранилища.
   *
   * @param orderId - ID ордера для удаления
   */
  delete(orderId: OrderId): void;

  /**
   * Возвращает все открытые ордера стратегии.
   *
   * @param strategyId - ID стратегии
   * @returns Readonly массив ордеров стратегии
   *
   * @remarks
   * Используется TradingAPI.getOpenOrders().
   */
  getByStrategyId(strategyId: string): readonly Order[];

  /**
   * O(1) счётчик открытых ордеров.
   *
   * @param strategyId - ID стратегии (если undefined — все ордера)
   * @returns Количество открытых ордеров
   *
   * @remarks
   * Используется OrderRiskChecker для проверки лимита открытых ордеров.
   */
  countByStrategyId(strategyId?: string): number;
}
