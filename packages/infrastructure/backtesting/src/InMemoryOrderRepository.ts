/**
 * InMemoryOrderRepository — хранилище ордеров в памяти для бектестирования.
 *
 * @remarks
 * Реализует интерфейс `IOrderRepository` на основе `Map`.
 * Используется в `BacktestEngine` как замена Redis/Postgres хранилища.
 *
 * ### Особенности:
 * - Все операции синхронны под капотом, обёрнуты в Promise для совместимости с интерфейсом.
 * - `getByStrategyId()` выполняет линейный поиск O(n) — приемлемо для бектеста.
 * - `countByStrategyId()` считает через фильтрацию всего Map.
 * - `getAll()` возвращает snapshot всех значений на момент вызова.
 *
 * @example
 * ```typescript
 * const repo = new InMemoryOrderRepository();
 * await repo.save(order);
 *
 * const found = await repo.get(order.id);
 * console.log(found?.id); // order.id
 *
 * const strategyOrders = await repo.getByStrategyId('strategy-1');
 * ```
 */
import type { Order } from '@polymarket/order';
import type { OrderId, MarketId } from '@polymarket/ids';
import type { IOrderRepository } from '@polymarket/ports';

/**
 * In-memory реализация хранилища Order агрегатов.
 *
 * @remarks
 * Хранит ордера в `Map<OrderId, Order>`.
 * Не потокобезопасна (Node.js single-thread достаточно для бектеста).
 */
export class InMemoryOrderRepository implements IOrderRepository {
  /** Внутреннее хранилище: OrderId → Order */
  private readonly _store = new Map<OrderId, Order>();

  /**
   * Возвращает Order по ID или undefined если не найден.
   *
   * @param orderId - ID ордера
   * @returns Promise с Order агрегатом или undefined
   *
   * @example
   * ```typescript
   * const order = await repo.get(orderId);
   * if (!order) {
   *   console.log('Order not found');
   * }
   * ```
   */
  public async get(orderId: OrderId): Promise<Order | undefined> {
    return this._store.get(orderId);
  }

  /**
   * Сохраняет (или перезаписывает) Order агрегат.
   *
   * @param order - Order для сохранения
   * @returns Promise<void>
   *
   * @example
   * ```typescript
   * await repo.save(order);
   * ```
   */
  public async save(order: Order): Promise<void> {
    this._store.set(order.id, order);
  }

  /**
   * Удаляет Order из хранилища.
   *
   * @remarks
   * Безопасен при вызове с несуществующим ID (no-op).
   *
   * @param orderId - ID ордера для удаления
   * @returns Promise<void>
   *
   * @example
   * ```typescript
   * await repo.delete(orderId);
   * ```
   */
  public async delete(orderId: OrderId): Promise<void> {
    this._store.delete(orderId);
  }

  /**
   * Возвращает все ордера заданной стратегии.
   *
   * @remarks
   * Выполняет линейный поиск O(n) по всему Map.
   * Допустимо в бектесте, где объём данных ограничен.
   *
   * @param strategyId - ID стратегии
   * @returns Promise с readonly массивом ордеров стратегии
   *
   * @example
   * ```typescript
   * const orders = await repo.getByStrategyId('my-strategy');
   * console.log('Open orders:', orders.length);
   * ```
   */
  public async getByStrategyId(strategyId: string): Promise<readonly Order[]> {
    const result: Order[] = [];
    for (const order of this._store.values()) {
      if (order.strategyId === strategyId) {
        result.push(order);
      }
    }
    return result;
  }

  /**
   * Возвращает количество ордеров заданной стратегии.
   *
   * @remarks
   * Если `strategyId` не указан — возвращает общее количество ордеров в хранилище.
   * Выполняет линейный проход O(n).
   *
   * @param strategyId - ID стратегии (если undefined — все ордера)
   * @returns Promise с количеством ордеров
   *
   * @example
   * ```typescript
   * const count = await repo.countByStrategyId('my-strategy');
   * const total = await repo.countByStrategyId();
   * ```
   */
  public async countByStrategyId(strategyId?: string): Promise<number> {
    if (strategyId === undefined) {
      return this._store.size;
    }
    let count = 0;
    for (const order of this._store.values()) {
      if (order.strategyId === strategyId) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Возвращает все ордера из хранилища.
   *
   * @remarks
   * Возвращает snapshot значений Map на момент вызова.
   * Изменения в Map после вызова не отражаются в возвращённом массиве.
   *
   * @returns Promise с readonly массивом всех ордеров
   *
   * @example
   * ```typescript
   * const all = await repo.getAll();
   * console.log('Total orders:', all.length);
   * ```
   */
  public async getAll(): Promise<readonly Order[]> {
    return [...this._store.values()];
  }

  /**
   * Возвращает все ордера указанного рынка.
   *
   * @remarks
   * Реализует конвенцию «strategyId == String(marketId)» в одном месте.
   * Вызывающий код (`CloseMarketUseCase`) работает с типизированным `MarketId`
   * и не знает о деталях хранения.
   *
   * @param marketId - ID рынка
   * @returns Promise с readonly массивом ордеров рынка
   *
   * @example
   * ```typescript
   * const orders = await repo.getByMarketId(marketId);
   * ```
   */
  public async getByMarketId(marketId: MarketId): Promise<readonly Order[]> {
    return this.getByStrategyId(String(marketId));
  }

  /**
   * Возвращает количество ордеров в хранилище.
   *
   * @remarks
   * Вспомогательный метод для тестовых assertions.
   *
   * @returns Количество ордеров
   *
   * @example
   * ```typescript
   * expect(repo.size).toBe(3);
   * ```
   */
  public get size(): number {
    return this._store.size;
  }

  /**
   * Очищает хранилище.
   *
   * @remarks
   * Используется в тестах для сброса состояния между тестами.
   *
   * @example
   * ```typescript
   * beforeEach(() => repo.clear());
   * ```
   */
  public clear(): void {
    this._store.clear();
  }
}
