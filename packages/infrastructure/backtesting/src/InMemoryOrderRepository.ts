/**
 * InMemoryOrderRepository — хранилище ордеров в памяти для бектестирования.
 *
 * @remarks
 * Реализует интерфейсы `IOrderRepository` (async) и `IOrderStateStore` (sync)
 * на основе `Map`.
 * Используется в `BacktestEngine` как замена Redis/Postgres хранилища.
 *
 * ### Особенности:
 * - Все операции синхронны под капотом, обёрнуты в Promise для совместимости с IOrderRepository.
 * - `IOrderStateStore` — синхронные методы для StrategyScheduler (без async overhead).
 * - `getByStrategyId()` выполняет линейный поиск O(n) — приемлемо для бектеста.
 * - `countByStrategyId()` считает только активные (не терминальные) ордера.
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
import type { OrderId, MarketId, InstrumentId } from '@polymarket/ids';
import type { IOrderRepository, IOrderStateStore } from '@polymarket/ports';

/**
 * In-memory реализация хранилища Order агрегатов.
 *
 * @remarks
 * Хранит ордера в `Map<OrderId, Order>`.
 * Реализует оба интерфейса:
 * - `IOrderRepository` — async для use-cases и handlers
 * - `IOrderStateStore` — sync для StrategyScheduler
 * Не потокобезопасна (Node.js single-thread достаточно для бектеста).
 */
export class InMemoryOrderRepository implements IOrderRepository, IOrderStateStore {
  /** Внутреннее хранилище: OrderId → Order */
  private readonly _store = new Map<OrderId, Order>();

  /**
   * Множество orderId, помеченных как MATCHED на бирже.
   *
   * @remarks
   * Заполняется при получении WS-события status=MATCHED.
   * Используется CancelOrderUseCase для блокировки отмены MATCHED ордеров.
   */
  private readonly _matchedOnExchange = new Set<string>();

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
    let count = 0;
    for (const order of this._store.values()) {
      // Считаем только активные (не терминальные) ордера
      if (order.isTerminal) continue;
      if (strategyId !== undefined && order.strategyId !== strategyId) continue;
      count += 1;
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

  // ── IOrderStateStore (sync methods) ──────────────────────

  /**
   * Sync: возвращает все ордера стратегии.
   *
   * @param strategyId - ID стратегии
   * @returns Readonly массив ордеров стратегии
   *
   * @remarks
   * Синхронная версия getByStrategyId() для StrategyScheduler.
   */
  public getOpenOrders(strategyId: string): readonly Order[] {
    const result: Order[] = [];
    for (const order of this._store.values()) {
      if (order.strategyId === strategyId) {
        result.push(order);
      }
    }
    return result;
  }

  /**
   * Sync: возвращает ордера стратегии на конкретном инструменте.
   *
   * @param strategyId - ID стратегии
   * @param instrumentId - ID инструмента (tokenId)
   * @returns Readonly массив ордеров
   *
   * @remarks
   * Фильтрует по strategyId и сравнивает order.asset с instrumentId (string match).
   */
  public getOpenOrdersByInstrument(strategyId: string, instrumentId: InstrumentId): readonly Order[] {
    const instrumentStr = String(instrumentId);
    const result: Order[] = [];
    for (const order of this._store.values()) {
      if (order.isTerminal) continue;
      // AssetId — объект ({type, tokenId}), поэтому String() даёт "[object Object]".
      // Для CTF-токенов Polymarket tokenId совпадает с InstrumentId.
      const assetStr =
        order.asset.type === 'POLYMARKET_CTF_TOKEN'
          ? order.asset.tokenId
          : String(order.asset);
      if (order.strategyId === strategyId && assetStr === instrumentStr) {
        result.push(order);
      }
    }
    return result;
  }

  /**
   * Sync: возвращает ордер по ID.
   *
   * @param orderId - ID ордера
   * @returns Order или undefined
   */
  public getOrder(orderId: OrderId): Order | undefined {
    return this._store.get(orderId);
  }

  /**
   * Sync: сохраняет (перезаписывает) ордер в хранилище без async overhead.
   *
   * @param order - Order для сохранения
   *
   * @remarks
   * Используется в ProcessFillUseCase для устранения race condition:
   * ордер помечается как FILED синхронно до обновления Portfolio,
   * что исключает yield-окно между двумя state-мутациями.
   */
  public saveSync(order: Order): void {
    this._store.set(order.id, order);
  }

  /**
   * Помечает ордер как MATCHED на бирже.
   *
   * @param orderId - ID ордера
   *
   * @remarks
   * Вызывается при получении WS status=MATCHED.
   * После пометки CancelOrderUseCase пропустит отмену этого ордера.
   */
  public markMatchedOnExchange(orderId: OrderId): void {
    this._matchedOnExchange.add(String(orderId));
  }

  /**
   * Возвращает true если ордер помечен как MATCHED на бирже.
   *
   * @param orderId - ID ордера
   * @returns true если WS сообщил MATCHED для этого ордера
   */
  public isMatchedOnExchange(orderId: OrderId): boolean {
    return this._matchedOnExchange.has(String(orderId));
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
