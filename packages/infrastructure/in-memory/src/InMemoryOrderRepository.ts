/**
 * InMemoryOrderRepository — хранилище ордеров в памяти для бектестирования.
 *
 * @remarks
 * Реализует интерфейсы `IOrderRepository` (async, CAS) и `IOrderStateStore` (sync)
 * на основе `Map`.
 * Используется в `BacktestEngine` как замена Redis/Postgres хранилища.
 *
 * ### Особенности:
 * - Все операции синхронны под капотом, обёрнуты в Promise для совместимости с IOrderRepository.
 * - **Optimistic concurrency (CAS)**: каждая запись хранится как `OrderRecord`
 *   с монотонно растущей версией. `save(order, expectedVersion)` и
 *   `deleteIfVersion()` — условные; stale write возвращает `Err(VersionConflictError)`
 *   и не изменяет хранимую запись. Новый ордер сохраняется с `expectedVersion=0`.
 * - `deleteIfState()` — условное удаление по статусу (для cleanup терминальных ордеров).
 * - `IOrderStateStore` — синхронные методы для StrategyScheduler (без async overhead).
 * - `getByStrategyId()` выполняет линейный поиск O(n) — приемлемо для бектеста.
 * - `countByStrategyId()` считает только активные (не терминальные) ордера.
 * - `getAll()` возвращает snapshot всех значений на момент вызова.
 *
 * @example
 * ```typescript
 * const repo = new InMemoryOrderRepository();
 * const saved = await repo.save(order, 0); // новый ордер → expectedVersion=0
 * if (!saved.ok) throw saved.error;
 *
 * const found = await repo.get(order.id);
 * console.log(found?.id); // order.id
 *
 * const version = await repo.getVersion(order.id); // 1
 * const updated = await repo.save(mutatedOrder, version);
 * ```
 */
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { Order, OrderStatus } from '@polymarket/order';
import type { OrderId, MarketId, InstrumentId, FillId } from '@polymarket/ids';
import { assetIdToInstrumentId } from '@polymarket/ids';
import type {
  IOrderRepository,
  IOrderStateStore,
  IMarketCatalog,
  InFlightFill,
  InFlightFillStatus,
  MarkInFlightFillInput,
  FillProcessingBlock,
  FillProcessingStatus,
  MarkFillProcessingInput,
  ManualReconciliationBlock,
  TerminalSettlementPending,
  DeleteOrderResult,
} from '@polymarket/ports';
import { pendingMatchFillId, VersionConflictError, OrderStateConflictError } from '@polymarket/ports';

/**
 * Запись хранилища: Order + версия для optimistic concurrency.
 *
 * @remarks
 * Версия монотонно растёт при каждой записи (CAS `save` и `saveSync`).
 * Первое сохранение даёт version=1; отсутствующий ордер имеет версию 0.
 */
interface OrderRecord {
  readonly order: Order;
  readonly version: number;
}

/**
 * In-memory реализация хранилища Order агрегатов.
 *
 * @remarks
 * Хранит ордера в `Map<OrderId, OrderRecord>` (Order + версия).
 * Реализует оба интерфейса:
 * - `IOrderRepository` — async CAS API для use-cases и handlers
 * - `IOrderStateStore` — sync для StrategyScheduler
 * Не потокобезопасна (Node.js single-thread достаточно для бектеста).
 */
export class InMemoryOrderRepository implements IOrderRepository, IOrderStateStore {
  /** Внутреннее хранилище: OrderId → OrderRecord (Order + версия) */
  private readonly _store = new Map<OrderId, OrderRecord>();

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
   * Application-level processing-блоки: instrumentId(строкой) → Map<FillId, block>.
   *
   * @remarks
   * ОТДЕЛЬНАЯ ось от venue in-flight (`_inFlightFillsByInstrument`): отражает,
   * довёл ли ProcessFillUseCase обработку до конца (PROCESSING/FAILED_RETRYABLE/
   * RECONCILIATION_REQUIRED). НЕ снимается автоматически на retryable/reconciliation.
   */
  private readonly _fillProcessingByInstrument = new Map<string, Map<FillId, FillProcessingBlock>>();

  /** fillId → instrumentId(строкой) — обратный индекс для processing-блоков. */
  private readonly _fillProcessingInstrumentIndex = new Map<FillId, string>();

  /**
   * Manual reconciliation blocks: orderId(строкой) → block.
   *
   * @remarks
   * ОТДЕЛЬНАЯ ось от venue in-flight и fill processing-блоков: ставится
   * use-case'ами при частичном commit (Portfolio↔journal desync), участвует в
   * `hasUnsettledFills` и НЕ снимается fill-ами — только явным
   * `clearManualReconciliationBlock` (оператор/recovery-тулинг).
   */
  private readonly _manualBlocksByOrder = new Map<string, ManualReconciliationBlock>();

  /**
   * Terminal settlement pending: orderId(строкой) → запись.
   *
   * @remarks
   * Авторитетный terminal venue-update получен, но held-резервация ещё не
   * освобождена (окно delayed fill). Участвует в `hasUnsettledFills`, снимается
   * ТОЛЬКО `SettleTerminalOrdersUseCase` после Portfolio + journal settlement.
   */
  private readonly _terminalSettlementByOrder = new Map<string, TerminalSettlementPending>();

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
    return this._store.get(orderId)?.order;
  }

  /**
   * Возвращает текущую версию записи Order.
   *
   * @param orderId - ID ордера
   * @returns Promise с версией записи; `0` — если Order отсутствует
   *
   * @remarks
   * Читается ПЕРЕД мутацией Order и передаётся в `save()` как `expectedVersion`.
   *
   * @example
   * ```typescript
   * const version = await repo.getVersion(orderId); // 0 для нового ордера
   * ```
   */
  public async getVersion(orderId: OrderId): Promise<number> {
    return this._store.get(orderId)?.version ?? 0;
  }

  /**
   * Атомарно возвращает Order вместе с его текущей версией.
   *
   * @param orderId - ID ордера
   * @returns Promise с `{ order, version }` или undefined, если Order отсутствует
   *
   * @remarks
   * Предпочтительнее раздельных `get()` + `getVersion()` перед CAS-мутацией:
   * гарантирует, что `version` относится к ТОЙ ЖЕ записи (единое чтение из
   * `_store`, без yield-окна между двумя await, в котором конкурирующая
   * мутация могла бы рассинхронизировать пару).
   *
   * @example
   * ```typescript
   * const snapshot = await repo.getWithVersion(orderId);
   * if (!snapshot) return Ok(undefined);
   * const cancelled = snapshot.order.cancel();
   * if (cancelled.ok) await repo.save(cancelled.value, snapshot.version);
   * ```
   */
  public async getWithVersion(
    orderId: OrderId,
  ): Promise<{ readonly order: Order; readonly version: number } | undefined> {
    const record = this._store.get(orderId);
    return record ? { order: record.order, version: record.version } : undefined;
  }

  /**
   * CAS-сохранение Order: записывает только при совпадении версии.
   *
   * @param order - Order для сохранения
   * @param expectedVersion - Ожидаемая текущая версия записи
   *   (`0` для нового ордера; иначе значение из `getVersion()`)
   * @returns Ok(void) при успехе; Err(VersionConflictError) при stale save
   *
   * @remarks
   * При конфликте хранимый Order НЕ изменяется. Повторный save с тем же
   * `expectedVersion` после успешного save конфликтует (версия уже выросла).
   *
   * @example
   * ```typescript
   * const result = await repo.save(order, 0); // новый ордер
   * if (!result.ok) {
   *   // stale save — перечитать get()/getVersion() и решить
   * }
   * ```
   */
  public async save(
    order: Order,
    expectedVersion: number,
  ): Promise<Result<void, VersionConflictError>> {
    const existing = this._store.get(order.id);
    const currentVersion = existing?.version ?? 0;

    if (currentVersion !== expectedVersion) {
      return Err(new VersionConflictError(String(order.id), expectedVersion, currentVersion));
    }

    this._store.set(order.id, {
      order,
      version: currentVersion + 1,
    });

    return Ok(undefined);
  }

  /**
   * Условное удаление Order по версии.
   *
   * @param orderId - ID ордера для удаления
   * @param expectedVersion - Ожидаемая текущая версия записи
   * @returns Ok({status:'DELETED'}) — удалён; Ok({status:'NOT_FOUND'}) —
   *   отсутствовал при `expectedVersion=0`; Err(VersionConflictError) —
   *   версия не совпала (запись не изменяется)
   *
   * @example
   * ```typescript
   * const version = await repo.getVersion(orderId);
   * const result = await repo.deleteIfVersion(orderId, version);
   * ```
   */
  public async deleteIfVersion(
    orderId: OrderId,
    expectedVersion: number,
  ): Promise<Result<DeleteOrderResult, VersionConflictError>> {
    const existing = this._store.get(orderId);
    const currentVersion = existing?.version ?? 0;

    if (currentVersion !== expectedVersion) {
      return Err(new VersionConflictError(String(orderId), expectedVersion, currentVersion));
    }

    if (!existing) {
      // expectedVersion === 0 и ордера нет — идемпотентный no-op.
      return Ok({ status: 'NOT_FOUND' });
    }

    this._store.delete(orderId);
    return Ok({ status: 'DELETED' });
  }

  /**
   * Условное удаление Order по статусу (а не по версии).
   *
   * @param orderId - ID ордера для удаления
   * @param allowedStates - Статусы, в которых удаление разрешено
   * @returns Ok({status:'DELETED'}) — удалён; Ok({status:'NOT_FOUND'}) —
   *   отсутствовал; Err(OrderStateConflictError) — статус вне allowedStates
   *
   * @remarks
   * Для cleanup-путей (OrderEventBridge удаляет терминальные ордера): важна
   * инвариантность «удаляем только терминальный ордер», а не конкретная версия.
   *
   * @example
   * ```typescript
   * const result = await repo.deleteIfState(orderId, ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
   * ```
   */
  public async deleteIfState(
    orderId: OrderId,
    allowedStates: readonly OrderStatus[],
  ): Promise<Result<DeleteOrderResult, OrderStateConflictError>> {
    const existing = this._store.get(orderId);
    if (!existing) {
      return Ok({ status: 'NOT_FOUND' });
    }

    if (!allowedStates.includes(existing.order.status)) {
      return Err(new OrderStateConflictError(orderId, allowedStates, existing.order.status));
    }

    this._store.delete(orderId);
    return Ok({ status: 'DELETED' });
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
    for (const record of this._store.values()) {
      if (record.order.strategyId === strategyId && !record.order.isTerminal) {
        result.push(record.order);
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
    for (const record of this._store.values()) {
      const order = record.order;
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
   * Возвращает ВСЕ ордера из хранилища — включая терминальные, ещё не удалённые
   * cleanup-путём (`deleteIfState`/`deleteIfVersion`).
   *
   * @remarks
   * НЕ фильтрует по статусу — в отличие от `getByStrategyId()`/`getByMarketId()`.
   * OrderReconciler и итоговая отчётность бектеста (`runMultiMarketBacktest.ts`)
   * читают именно этот полный снимок хранилища, а не только открытые ордера.
   * Возвращает snapshot значений Map на момент вызова.
   * Изменения в Map после вызова не отражаются в возвращённом массиве.
   *
   * @returns Promise с readonly массивом всех сохранённых ордеров
   *
   * @example
   * ```typescript
   * const all = await repo.getAll();
   * console.log('Total orders:', all.length);
   * ```
   */
  public async getAll(): Promise<readonly Order[]> {
    return [...this._store.values()].map((record) => record.order);
  }

  /**
   * Возвращает все ОТКРЫТЫЕ (не терминальные) ордера указанного рынка.
   *
   * @remarks
   * Фильтрует по `!order.isTerminal` независимо от того, каким путём реализация
   * искала ордера рынка (marketCatalog или legacy-конвенция) — семантика
   * «открытые» должна совпадать с `getByStrategyId()`.
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
   * @returns Promise с readonly массивом открытых ордеров рынка
   *
   * @example
   * ```typescript
   * const orders = await repo.getByMarketId(marketId);
   * ```
   */
  public async getByMarketId(marketId: MarketId): Promise<readonly Order[]> {
    if (!this._marketCatalog) {
      // getByStrategyId() уже фильтрует !isTerminal — семантика совпадает.
      return this.getByStrategyId(String(marketId));
    }

    const instruments = this._marketCatalog.getAllByMarketId(marketId);
    if (instruments.length === 0) {
      return [];
    }
    const instrumentIds = new Set(instruments.map((i) => i.instrumentId));

    const result: Order[] = [];
    for (const record of this._store.values()) {
      const order = record.order;
      if (order.isTerminal) continue;
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
    for (const record of this._store.values()) {
      if (record.order.strategyId === strategyId && !record.order.isTerminal) {
        result.push(record.order);
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
    for (const record of this._store.values()) {
      const order = record.order;
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
    return this._store.get(orderId)?.order;
  }

  /**
   * Sync: сохраняет (перезаписывает) ордер в хранилище без async overhead.
   *
   * @param order - Order для сохранения
   *
   * @remarks
   * Используется в ProcessFillUseCase для устранения race condition:
   * ордер помечается как FILLED синхронно до обновления Portfolio,
   * что исключает yield-окно между двумя state-мутациями.
   *
   * ВАЖНО: saveSync НАМЕРЕННО обходит CAS-проверку (нет expectedVersion),
   * но версию записи инкрементирует — конкурирующий CAS `save()` со stale
   * версией после saveSync корректно получит VersionConflictError.
   * TODO: устранить saveSync отдельным Unit of Work/CAS refactor; сейчас он
   * нужен только для существующего no-yield fill/cancel race fix в
   * ProcessFillUseCase.
   */
  public saveSync(order: Order): void {
    const existing = this._store.get(order.id);
    this._store.set(order.id, {
      order,
      version: (existing?.version ?? 0) + 1,
    });
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
   * Очищает не только `_store` (ордера + версии), но и все fillId-scoped
   * индексы (matched fills, in-flight fills) — иначе `hasMatchedFills()`/
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
    this._fillProcessingByInstrument.clear();
    this._fillProcessingInstrumentIndex.clear();
    this._manualBlocksByOrder.clear();
    this._terminalSettlementByOrder.clear();
  }

  // ── In-flight fills (instrument-level) ─────────────────

  /**
   * Помечает конкретный fill как in-flight на уровне инструмента.
   *
   * @param input - `{ instrumentId, fillId, orderId, status }`;
   *   `status` — только не-терминальные `MATCHED`/`MINED`
   *
   * @remarks
   * Вызывается при каждом MATCHED/MINED fill. Идемпотентен по fillId:
   * повторная пометка того же fillId (дублирующееся WS-событие) не создаёт
   * вторую запись и не «удваивает» in-flight состояние — существующая запись
   * перезаписывается с переданным `input.status` (MATCHED → MINED допустимо).
   */
  public markInFlightFill(input: MarkInFlightFillInput): void {
    const { instrumentId, fillId, orderId, status } = input;
    const key = String(instrumentId);
    let byFillId = this._inFlightFillsByInstrument.get(key);
    if (!byFillId) {
      byFillId = new Map<FillId, InFlightFill>();
      this._inFlightFillsByInstrument.set(key, byFillId);
    }
    byFillId.set(fillId, { fillId, orderId, instrumentId, status });
    this._inFlightFillInstrumentIndex.set(fillId, key);
  }

  /**
   * Обновляет статус уже отслеживаемого in-flight fill.
   *
   * @param fillId - ID fill-события, ранее переданный в `markInFlightFill`
   * @param status - Новый on-chain статус (включая терминальные CONFIRMED/FAILED)
   *
   * @remarks
   * Неизвестный fillId — no-op (запись уже снята или никогда не помечалась).
   * Не снимает запись — снятие остаётся явным `clearInFlightFill(fillId)`.
   */
  public updateInFlightFillStatus(fillId: FillId, status: InFlightFillStatus): void {
    const key = this._inFlightFillInstrumentIndex.get(fillId);
    if (!key) return;
    const byFillId = this._inFlightFillsByInstrument.get(key);
    const existing = byFillId?.get(fillId);
    if (!byFillId || !existing) return;
    byFillId.set(fillId, { ...existing, status });
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

  // ── Application-level fill processing blocks (Stage 6) ──────────────────────

  /**
   * Ставит processing-блок (`PROCESSING`) на fill. Идемпотентен по fillId.
   *
   * @param input - `{ fillId, orderId, instrumentId }`
   */
  public markFillProcessing(input: MarkFillProcessingInput): void {
    const key = String(input.instrumentId);
    let byFillId = this._fillProcessingByInstrument.get(key);
    if (!byFillId) {
      byFillId = new Map<FillId, FillProcessingBlock>();
      this._fillProcessingByInstrument.set(key, byFillId);
    }
    byFillId.set(input.fillId, {
      fillId: input.fillId,
      orderId: input.orderId,
      instrumentId: input.instrumentId,
      status: 'PROCESSING',
    });
    this._fillProcessingInstrumentIndex.set(input.fillId, key);
  }

  /**
   * Обновляет статус processing-блока (не снимает его). Неизвестный fillId — no-op.
   *
   * @param fillId - ID fill
   * @param status - Новый статус
   */
  public updateFillProcessingStatus(fillId: FillId, status: FillProcessingStatus): void {
    const key = this._fillProcessingInstrumentIndex.get(fillId);
    if (key === undefined) return;
    const byFillId = this._fillProcessingByInstrument.get(key);
    const existing = byFillId?.get(fillId);
    if (!existing) return;
    byFillId!.set(fillId, { ...existing, status });
  }

  /**
   * Снимает processing-блок с fill. Неизвестный fillId — no-op.
   *
   * @param fillId - ID fill
   */
  public clearFillProcessing(fillId: FillId): void {
    const key = this._fillProcessingInstrumentIndex.get(fillId);
    if (key === undefined) return;
    const byFillId = this._fillProcessingByInstrument.get(key);
    if (byFillId) {
      byFillId.delete(fillId);
      if (byFillId.size === 0) this._fillProcessingByInstrument.delete(key);
    }
    this._fillProcessingInstrumentIndex.delete(fillId);
  }

  /**
   * Есть ли на инструменте processing-блоки.
   *
   * @param instrumentId - ID инструмента
   * @returns true если есть хотя бы один блок
   */
  public hasFillProcessingBlocks(instrumentId: InstrumentId): boolean {
    const byFillId = this._fillProcessingByInstrument.get(String(instrumentId));
    return !!byFillId && byFillId.size > 0;
  }

  /**
   * Возвращает все processing-блоки инструмента.
   *
   * @param instrumentId - ID инструмента
   * @returns Readonly массив блоков
   */
  public getFillProcessingBlocks(instrumentId: InstrumentId): readonly FillProcessingBlock[] {
    const byFillId = this._fillProcessingByInstrument.get(String(instrumentId));
    return byFillId ? [...byFillId.values()] : [];
  }

  /**
   * Есть ли на инструменте НЕзавершённые fills (venue in-flight ЛИБО processing-блок).
   *
   * @param instrumentId - ID инструмента
   * @returns `hasInFlightFills(id) || hasFillProcessingBlocks(id)`
   */
  public hasUnsettledFills(instrumentId: InstrumentId): boolean {
    return (
      this.hasInFlightFills(instrumentId) ||
      this.hasFillProcessingBlocks(instrumentId) ||
      this.hasManualReconciliationBlocks(instrumentId) ||
      this.hasTerminalSettlementPending(instrumentId)
    );
  }

  // ── Terminal settlement pending ─────────────────────────────────────────────

  /**
   * Ставит terminal settlement pending (идемпотентно по orderId).
   *
   * @param pending - `{ orderId, instrumentId, venueStatus, receivedAt }`
   */
  public markTerminalSettlementPending(pending: TerminalSettlementPending): void {
    this._terminalSettlementByOrder.set(String(pending.orderId), {
      orderId: pending.orderId,
      instrumentId: pending.instrumentId,
      venueStatus: pending.venueStatus,
      receivedAt: new Date(pending.receivedAt.getTime()),
    });
  }

  /**
   * Снимает terminal settlement pending (no-op если нет).
   *
   * @param orderId - ID ордера
   */
  public clearTerminalSettlementPending(orderId: OrderId): void {
    this._terminalSettlementByOrder.delete(String(orderId));
  }

  /**
   * Есть ли terminal settlement pending на конкретном ордере.
   *
   * @param orderId - ID ордера
   * @returns true если settlement не разрешён
   */
  public hasTerminalSettlementPendingForOrder(orderId: OrderId): boolean {
    return this._terminalSettlementByOrder.has(String(orderId));
  }

  /**
   * Есть ли на инструменте хотя бы один terminal settlement pending.
   *
   * @param instrumentId - ID инструмента
   * @returns true если есть неразрешённые terminal settlements
   */
  public hasTerminalSettlementPending(instrumentId: InstrumentId): boolean {
    const key = String(instrumentId);
    for (const pending of this._terminalSettlementByOrder.values()) {
      if (String(pending.instrumentId) === key) return true;
    }
    return false;
  }

  /**
   * Возвращает все terminal settlement pending записи.
   *
   * @returns Readonly массив pending записей
   */
  public getTerminalSettlementPending(): readonly TerminalSettlementPending[] {
    return [...this._terminalSettlementByOrder.values()];
  }

  // ── Manual reconciliation blocks ─────────────────────────────────────────────

  /**
   * Ставит manual reconciliation block (идемпотентно по orderId).
   *
   * @param block - `{ orderId, instrumentId, reason }`
   */
  public markManualReconciliationBlock(block: ManualReconciliationBlock): void {
    this._manualBlocksByOrder.set(String(block.orderId), {
      orderId: block.orderId,
      instrumentId: block.instrumentId,
      reason: block.reason,
    });
  }

  /**
   * Снимает manual reconciliation block (ТОЛЬКО ручная реконсиляция; no-op если нет).
   *
   * @param orderId - ID ордера
   */
  public clearManualReconciliationBlock(orderId: OrderId): void {
    this._manualBlocksByOrder.delete(String(orderId));
  }

  /**
   * Есть ли manual reconciliation block на конкретном ордере.
   *
   * @param orderId - ID ордера
   * @returns true если блок стоит
   */
  public hasManualReconciliationBlockForOrder(orderId: OrderId): boolean {
    return this._manualBlocksByOrder.has(String(orderId));
  }

  /**
   * Есть ли на инструменте хотя бы один manual reconciliation block.
   *
   * @param instrumentId - ID инструмента
   * @returns true если есть блок(и)
   */
  public hasManualReconciliationBlocks(instrumentId: InstrumentId): boolean {
    const key = String(instrumentId);
    for (const block of this._manualBlocksByOrder.values()) {
      if (String(block.instrumentId) === key) return true;
    }
    return false;
  }

  /**
   * Возвращает все manual reconciliation blocks инструмента.
   *
   * @param instrumentId - ID инструмента
   * @returns Readonly массив блоков
   */
  public getManualReconciliationBlocks(instrumentId: InstrumentId): readonly ManualReconciliationBlock[] {
    const key = String(instrumentId);
    return [...this._manualBlocksByOrder.values()].filter((b) => String(b.instrumentId) === key);
  }
}
