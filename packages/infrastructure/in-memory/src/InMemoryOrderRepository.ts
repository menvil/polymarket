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
import type { OrderId, MarketId, InstrumentId, FillId } from '@polymarket/ids';
import { assetIdToInstrumentId } from '@polymarket/ids';
import type { IOrderRepository, IOrderStateStore, IMarketCatalog, InFlightFill } from '@polymarket/ports';
import { pendingMatchFillId } from '@polymarket/ports';

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
   * @param _marketCatalog - Опциональный каталог инструментов для честной реализации
   * `getByMarketId()` через реальный marketId → instrumentId маппинг. Если не передан,
   * `getByMarketId()` использует legacy-фолбэк на конвенцию `strategyId == String(marketId)`
   * (см. doc `getByMarketId()`).
   */
  public constructor(private readonly _marketCatalog?: IMarketCatalog) {}

  /**
   * orderId → Set<FillId> matched на бирже (fillId-identity, не boolean/orderId-only).
   *
   * @remarks
   * Заполняется при получении WS-события status=MATCHED, по конкретному fillId
   * (либо `pendingMatchFillId(orderId)`, если fillId ещё не известен на этом уровне).
   * Используется CancelOrderUseCase для блокировки отмены ордеров с matched fills.
   * Каждый fillId снимается независимо в `clearOrderFillMatched` — partial fills
   * одного ордера не затирают состояние друг друга.
   */
  private readonly _matchedFillsByOrder = new Map<string, Set<FillId>>();

  /**
   * instrumentId → (fillId → InFlightFill). fillId-identity вместо счётчика.
   *
   * @remarks
   * Трекинг на уровне инструмента решает проблему: после cancel ордер удалён
   * из repo (terminal), но fill в пути on-chain. `hasMatchedFills(orderId)`
   * бесполезен — ордера нет в `getOpenOrdersByInstrument`. `hasInFlightFills(
   * instrumentId)` работает независимо от состояния ордера.
   *
   * Identity (Map<FillId, ...>), а не счётчик: повторная пометка ТОГО ЖЕ fillId
   * (дублирующееся WS-событие) идемпотентна (перезаписывает ту же запись, не
   * инкрементирует), а clear снимает ТОЛЬКО указанный fillId — другие
   * concurrent in-flight fills того же инструмента не затрагиваются.
   */
  private readonly _inFlightFillsByInstrument = new Map<string, Map<FillId, InFlightFill>>();

  /** fillId → instrumentId (строкой) — обратный индекс для O(1) clearInFlightFill(fillId). */
  private readonly _inFlightFillInstrumentIndex = new Map<FillId, string>();

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
   * Возвращает все ОТКРЫТЫЕ (не терминальные) ордера заданной стратегии.
   *
   * @remarks
   * Порт `IOrderRepository.getByStrategyId()` документирован как «все открытые
   * ордера» — раньше реализация этого не делала и возвращала ВСЕ ордера, включая
   * FILLED/CANCELED/REJECTED/EXPIRED, что могло привести к неверным решениям
   * у вызывающего кода (например, `ExecutionEngine` CANCEL_ALL пытался бы отменить
   * уже терминальные ордера). Фильтрация по `!order.isTerminal` приводит поведение
   * в соответствие с контрактом порта.
   *
   * Выполняет линейный поиск O(n) по всему Map.
   * Допустимо в бектесте, где объём данных ограничен.
   *
   * @param strategyId - ID стратегии
   * @returns Promise с readonly массивом ОТКРЫТЫХ ордеров стратегии
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
      if (order.strategyId === strategyId && !order.isTerminal) {
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
      // MATCHED на бирже → fill(ы) в пути, отменить нельзя, не считаем как "открытые".
      // Без этого фильтра MAX_OPEN_ORDERS блокирует новые ордера на 5-20 сек
      // пока MATCHED→CONFIRMED проходит через Polygon finality.
      if (this.hasMatchedFills(order.id)) continue;
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
   * Порт `IOrderRepository.getByMarketId()` требует поиска по РЕАЛЬНОМУ marketId
   * ордера, а не по конвенции `strategyId == String(marketId)` (`Order` не хранит
   * `marketId` напрямую — только `asset: AssetId`).
   *
   * Если конструктору передан `marketCatalog` — используется честная реализация:
   * `marketId` → `IMarketCatalog.getAllByMarketId()` → все instrumentId рынка,
   * затем фильтрация ордеров по `assetIdToInstrumentId(order.asset) ∈ instrumentIds`.
   * Используется `getAllByMarketId()`, а не `getByMarketId()` — бинарный рынок
   * Polymarket имеет два outcome-токена (YES/NO) на один marketId; `getByMarketId()`
   * вернул бы только один из них и пропустил ордера второго.
   *
   * Если `marketCatalog` не передан (обратная совместимость с существующими
   * call sites, где эта зависимость не нужна) — используется legacy-фолбэк на
   * конвенцию `strategyId == String(marketId)`. Он корректен только пока в системе
   * действует правило «одна стратегия — один рынок»; при её нарушении молча
   * пропустит часть ордеров.
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
    if (!this._marketCatalog) {
      return this.getByStrategyId(String(marketId));
    }

    const instruments = this._marketCatalog.getAllByMarketId(marketId);
    if (instruments.length === 0) {
      return [];
    }
    const instrumentIds = new Set(instruments.map((i) => i.instrumentId));

    const result: Order[] = [];
    for (const order of this._store.values()) {
      const orderInstrumentId = assetIdToInstrumentId(order.asset);
      if (orderInstrumentId && instrumentIds.has(orderInstrumentId)) {
        result.push(order);
      }
    }
    return result;
  }

  // ── IOrderStateStore (sync methods) ──────────────────────

  /**
   * Sync: возвращает все ОТКРЫТЫЕ (не терминальные) ордера стратегии.
   *
   * @param strategyId - ID стратегии
   * @returns Readonly массив открытых ордеров стратегии
   *
   * @remarks
   * Синхронная версия getByStrategyId() для StrategyScheduler.
   * Фильтрует терминальные статусы — симметрично `getOpenOrdersByInstrument()`
   * и контракту порта `IOrderStateStore.getOpenOrders()` («все открытые ордера»).
   */
  public getOpenOrders(strategyId: string): readonly Order[] {
    const result: Order[] = [];
    for (const order of this._store.values()) {
      if (order.strategyId === strategyId && !order.isTerminal) {
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
   * Помечает конкретный fill ордера как matched на бирже.
   *
   * @param orderId - ID ордера
   * @param fillId - ID fill-события (или `pendingMatchFillId(orderId)`)
   *
   * @remarks
   * Вызывается при получении WS status=MATCHED. После пометки CancelOrderUseCase
   * пропустит отмену этого ордера, пока `hasMatchedFills(orderId)` не станет false.
   * Идемпотентен: Set.add на существующий fillId — no-op.
   */
  public markOrderFillMatched(orderId: OrderId, fillId: FillId): void {
    const key = String(orderId);
    let set = this._matchedFillsByOrder.get(key);
    if (!set) {
      set = new Set<FillId>();
      this._matchedFillsByOrder.set(key, set);
    }
    set.add(fillId);
  }

  /**
   * Снимает пометку matched с конкретного fill ордера.
   *
   * @param orderId - ID ордера
   * @param fillId - ID fill-события, переданный ранее в `markOrderFillMatched`
   *
   * @remarks
   * Снимает ТОЛЬКО этот fillId — другой ещё не подтверждённый partial fill
   * того же ордера не затрагивается. Дополнительно снимает placeholder-запись
   * `pendingMatchFillId(orderId)` для этого ордера, если она есть (см. doc
   * `pendingMatchFillId` в `@polymarket/ports`).
   */
  public clearOrderFillMatched(orderId: OrderId, fillId: FillId): void {
    const key = String(orderId);
    const set = this._matchedFillsByOrder.get(key);
    if (!set) return;
    set.delete(fillId);
    set.delete(pendingMatchFillId(orderId));
    if (set.size === 0) {
      this._matchedFillsByOrder.delete(key);
    }
  }

  /**
   * Возвращает true если у ордера есть хотя бы один matched (ещё не cleared) fill.
   *
   * @param orderId - ID ордера
   * @returns true если WS сообщил MATCHED хотя бы для одного fill этого ордера
   */
  public hasMatchedFills(orderId: OrderId): boolean {
    const set = this._matchedFillsByOrder.get(String(orderId));
    return !!set && set.size > 0;
  }

  /**
   * Возвращает все ID fill-ов, помеченных matched для данного ордера.
   *
   * @param orderId - ID ордера
   * @returns Readonly массив FillId (пустой, если matched-fill-ов нет)
   */
  public getMatchedFillIds(orderId: OrderId): readonly FillId[] {
    const set = this._matchedFillsByOrder.get(String(orderId));
    return set ? [...set] : [];
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
   * Очищает не только `_store`, но и все fillId-scoped индексы
   * (matched fills, in-flight fills) — иначе `hasMatchedFills()`/
   * `hasInFlightFills()` продолжат возвращать состояние из предыдущего теста.
   *
   * @example
   * ```typescript
   * beforeEach(() => repo.clear());
   * ```
   */
  public clear(): void {
    this._store.clear();
    this._matchedFillsByOrder.clear();
    this._inFlightFillsByInstrument.clear();
    this._inFlightFillInstrumentIndex.clear();
  }

  // ── In-flight fills (instrument-level) ─────────────────

  /**
   * Помечает конкретный fill как in-flight на уровне инструмента.
   *
   * @param instrumentId - ID инструмента
   * @param fillId - ID fill-события
   * @param orderId - ID ордера, к которому относится fill
   *
   * @remarks
   * Вызывается при каждом MATCHED fill. Идемпотентен: повторная пометка того
   * же fillId (дублирующееся WS-событие) — no-op по факту (перезаписывает ту
   * же запись), не создаёт вторую запись и не «удваивает» in-flight состояние.
   */
  public markInFlightFill(instrumentId: InstrumentId, fillId: FillId, orderId: OrderId): void {
    const key = String(instrumentId);
    let byFillId = this._inFlightFillsByInstrument.get(key);
    if (!byFillId) {
      byFillId = new Map<FillId, InFlightFill>();
      this._inFlightFillsByInstrument.set(key, byFillId);
    }
    byFillId.set(fillId, { fillId, orderId, instrumentId });
    this._inFlightFillInstrumentIndex.set(fillId, key);
  }

  /**
   * Снимает in-flight пометку с конкретного fill по его FillId.
   *
   * @param fillId - ID fill-события, ранее переданный в `markInFlightFill`
   *
   * @remarks
   * Идентифицирует запись по fillId через обратный индекс — не нужно знать
   * instrumentId на момент очистки. Неизвестный fillId — no-op (безопасно;
   * не может преждевременно снять in-flight состояние чужого fill).
   */
  public clearInFlightFill(fillId: FillId): void {
    const key = this._inFlightFillInstrumentIndex.get(fillId);
    if (!key) return;
    this._inFlightFillInstrumentIndex.delete(fillId);
    const byFillId = this._inFlightFillsByInstrument.get(key);
    if (byFillId) {
      byFillId.delete(fillId);
      if (byFillId.size === 0) {
        this._inFlightFillsByInstrument.delete(key);
      }
    }
  }

  /**
   * Возвращает true если на инструменте есть хотя бы один in-flight fill.
   *
   * @param instrumentId - ID инструмента
   */
  public hasInFlightFills(instrumentId: InstrumentId): boolean {
    const byFillId = this._inFlightFillsByInstrument.get(String(instrumentId));
    return !!byFillId && byFillId.size > 0;
  }

  /**
   * Возвращает все in-flight fills данного инструмента.
   *
   * @param instrumentId - ID инструмента
   * @returns Readonly массив `InFlightFill` (пустой, если in-flight fills нет)
   */
  public getInFlightFills(instrumentId: InstrumentId): readonly InFlightFill[] {
    const byFillId = this._inFlightFillsByInstrument.get(String(instrumentId));
    return byFillId ? [...byFillId.values()] : [];
  }
}
