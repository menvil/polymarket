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
import type { OrderId, MarketId } from '@polymarket/ids';

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

  /**
   * Возвращает все ордера указанного рынка.
   *
   * @param marketId - ID рынка
   * @returns Promise с readonly массивом ордеров рынка
   *
   * @remarks
   * Используется `CloseMarketUseCase` для получения ордеров перед закрытием рынка.
   * Реализации обязаны делать поиск по marketId, а не по strategyId —
   * это исключает зависимость от конвенции «strategyId == String(marketId)».
   */
  getByMarketId(marketId: MarketId): Promise<readonly Order[]>;

  /**
   * Возвращает все активные ордера во всех стратегиях.
   *
   * @returns Promise с readonly массивом всех ордеров
   *
   * @remarks
   * Используется OrderReconciler для сверки локальных ордеров с venue.
   * Для получения ордеров одной стратегии используй getByStrategyId().
   */
  getAll(): Promise<readonly Order[]>;
}
