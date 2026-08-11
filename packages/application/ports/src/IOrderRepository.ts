/**
 * Порт: хранилище активных Order агрегатов с optimistic concurrency control (CAS).
 *
 * @remarks
 * Единственное определение — только в @polymarket/ports.
 * Handlers и use-cases импортируют отсюда.
 * Реализации: InMemoryOrderRepository (Phase 1, packages/infrastructure/in-memory
 * и packages/infrastructure/backtesting). RedisOrderRepository (Phase 9,
 * см. master-plan.md → "Фаза 9: Recovery & Reconciliation") — запланирован,
 * но пока НЕ реализован.
 *
 * ### Optimistic concurrency (CAS):
 * Репозиторий версионирует каждую запись Order. Любая критическая запись
 * (`save`) или удаление (`deleteIfVersion` / `deleteIfState`) — условные:
 * - `getVersion(orderId)` возвращает текущую версию записи; `0` — если Order
 *   отсутствует в хранилище.
 * - `save(order, expectedVersion)` записывает Order ТОЛЬКО если текущая версия
 *   совпадает с `expectedVersion`. Новый Order сохраняется с `expectedVersion=0`.
 *   Stale save (версия ушла вперёд из-за конкурирующей мутации) возвращает
 *   `Err(VersionConflictError)` и НЕ изменяет хранимый Order.
 * - `deleteIfVersion(orderId, expectedVersion)` — условное удаление по версии.
 * - `deleteIfState(orderId, allowedStates)` — условное удаление по статусу,
 *   а не по версии: для cleanup-путей, где важно «удалить только терминальный
 *   ордер», а конкретная версия не важна.
 *
 * Это закрывает fill/cancel/reconcile гонки: устаревшая копия Order больше
 * не может молча перетереть более свежее состояние (last-write-wins устранён).
 *
 * Используется:
 * - FillEventHandler — `get(orderId)` → применить fill
 * - OrderUpdateHandler / UpdateOrderStatusUseCase — `getVersion()` + CAS `save()`
 * - PlaceOrderUseCase — `save(order, 0)` → сохранить новый ордер
 * - CancelOrderUseCase — `get()` / `getVersion()` + CAS `save()`
 * - OrderEventBridge — `deleteIfState()` → cleanup терминальных ордеров
 * - TradingAPI.getOpenOrders() — `getByStrategyId()`
 * - OrderRiskChecker — `countByStrategyId()` → O(1) проверка лимита
 */
import type { Result } from '@polymarket/result';
import type { Order, OrderStatus } from '@polymarket/order';
import type { OrderId, MarketId } from '@polymarket/ids';
import type { VersionConflictError } from './VersionConflictError.js';

/**
 * Результат условного удаления Order.
 *
 * @remarks
 * - `DELETED` — Order существовал и был удалён.
 * - `NOT_FOUND` — Order отсутствовал (идемпотентный no-op, не ошибка).
 */
export type DeleteOrderResult =
  | { readonly status: 'DELETED' }
  | { readonly status: 'NOT_FOUND' };

/**
 * Ошибка конфликта статуса Order при условном удалении по состоянию.
 *
 * @remarks
 * Возвращается (НЕ выбрасывается) как `Err(OrderStateConflictError)` из
 * `IOrderRepository.deleteIfState()`, когда фактический статус ордера
 * не входит в `allowedStates`. Хранимый Order при этом не изменяется.
 *
 * @example
 * ```typescript
 * const result = await repo.deleteIfState(orderId, ['FILLED', 'CANCELED']);
 * if (!result.ok) {
 *   logger.warn('Order not in deletable state', {
 *     orderId: String(result.error.orderId),
 *     actualState: result.error.actualState,
 *   });
 * }
 * ```
 */
export class OrderStateConflictError extends Error {
  /**
   * @param orderId - ID ордера с конфликтом статуса
   * @param expectedStates - Допустимые статусы, переданные в deleteIfState()
   * @param actualState - Фактический статус ордера в хранилище
   */
  constructor(
    readonly orderId: OrderId,
    readonly expectedStates: readonly OrderStatus[],
    readonly actualState: OrderStatus,
  ) {
    super(
      `Order ${String(orderId)} state conflict: expected one of [${expectedStates.join(', ')}], got ${actualState}`,
    );
    this.name = 'OrderStateConflictError';
  }
}

/** Порт CAS-хранилища Order — см. описание модуля выше. */
export interface IOrderRepository {
  /**
   * Возвращает Order по ID или undefined если не найден.
   *
   * @param orderId - ID ордера
   * @returns Promise с Order агрегатом или undefined
   */
  get(orderId: OrderId): Promise<Order | undefined>;

  /**
   * Возвращает текущую версию записи Order.
   *
   * @param orderId - ID ордера
   * @returns Promise с версией записи; `0` — если Order отсутствует
   *
   * @remarks
   * Читается ПЕРЕД мутацией Order и передаётся в `save()` как `expectedVersion`.
   * Для нового (ещё не сохранённого) ордера версия всегда `0`.
   *
   * Если нужны И Order, И его версия для последующей CAS-мутации —
   * используй `getWithVersion()`: раздельные `get()` + `getVersion()` содержат
   * yield-окно между двумя await, в котором конкурирующая мутация может
   * рассинхронизировать пару (версия читается для одного состояния записи,
   * Order — для другого). Это не ведёт к потере данных (CAS всё равно поймает
   * несовпадение при `save()`), но может вызвать ложный конфликт под нагрузкой.
   */
  getVersion(orderId: OrderId): Promise<number>;

  /**
   * Атомарно возвращает Order вместе с его текущей версией.
   *
   * @param orderId - ID ордера
   * @returns Promise с `{ order, version }` или undefined, если Order отсутствует
   *
   * @remarks
   * Предпочтительнее раздельных `get()` + `getVersion()` перед CAS-мутацией:
   * гарантирует, что `version` относится к ТОЙ ЖЕ записи, что и возвращённый
   * `order` — без yield-окна между двумя чтениями.
   *
   * @example
   * ```typescript
   * const snapshot = await repo.getWithVersion(orderId);
   * if (!snapshot) return Ok(undefined); // ордер не найден
   * const cancelled = snapshot.order.cancel();
   * if (cancelled.ok) await repo.save(cancelled.value, snapshot.version);
   * ```
   */
  getWithVersion(orderId: OrderId): Promise<{ readonly order: Order; readonly version: number } | undefined>;

  /**
   * CAS-сохранение Order: записывает только при совпадении версии.
   *
   * @param order - Order для сохранения
   * @param expectedVersion - Ожидаемая текущая версия записи
   *   (`0` для нового ордера; иначе значение из `getVersion()`)
   * @returns Ok(void) при успехе; Err(VersionConflictError) если текущая
   *   версия в хранилище не совпала с `expectedVersion` (stale save)
   *
   * @remarks
   * При конфликте хранимый Order НЕ изменяется. Caller обязан перечитать
   * актуальное состояние (`get()` + `getVersion()`) и решить: повторить
   * операцию, деградировать в no-op или вернуть ошибку.
   */
  save(
    order: Order,
    expectedVersion: number,
  ): Promise<Result<void, VersionConflictError>>;

  /**
   * Условное удаление Order по версии.
   *
   * @param orderId - ID ордера для удаления
   * @param expectedVersion - Ожидаемая текущая версия записи
   * @returns Ok({status:'DELETED'}) — удалён; Ok({status:'NOT_FOUND'}) —
   *   отсутствовал при `expectedVersion=0`; Err(VersionConflictError) —
   *   версия не совпала (Order не изменяется)
   */
  deleteIfVersion(
    orderId: OrderId,
    expectedVersion: number,
  ): Promise<Result<DeleteOrderResult, VersionConflictError>>;

  /**
   * Условное удаление Order по статусу (а не по версии).
   *
   * @param orderId - ID ордера для удаления
   * @param allowedStates - Статусы, в которых удаление разрешено
   * @returns Ok({status:'DELETED'}) — удалён; Ok({status:'NOT_FOUND'}) —
   *   отсутствовал (идемпотентный no-op); Err(OrderStateConflictError) —
   *   фактический статус не входит в allowedStates (Order не изменяется)
   *
   * @remarks
   * Для cleanup-путей (например, OrderEventBridge удаляет терминальные ордера):
   * важна инвариантность «удаляем только терминальный ордер», а не конкретная
   * версия записи.
   */
  deleteIfState(
    orderId: OrderId,
    allowedStates: readonly OrderStatus[],
  ): Promise<Result<DeleteOrderResult, OrderStateConflictError>>;

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
   * Счётчик открытых ордеров.
   *
   * @param strategyId - ID стратегии (если undefined — все ордера)
   * @returns Promise с количеством открытых ордеров
   *
   * @remarks
   * Используется OrderRiskChecker для проверки лимита открытых ордеров.
   * Контракт порта НЕ гарантирует O(1) — это специфика конкретного backend'а
   * (например, индекс в Redis/Postgres). In-memory реализация делает линейный
   * проход O(n), что приемлемо при её объёме данных.
   */
  countByStrategyId(strategyId?: string): Promise<number>;

  /**
   * Возвращает все ОТКРЫТЫЕ (не терминальные) ордера указанного рынка.
   *
   * @param marketId - ID рынка
   * @returns Promise с readonly массивом открытых ордеров рынка
   *
   * @remarks
   * Используется `CloseMarketUseCase` для получения ордеров перед закрытием рынка
   * (закрытие рынка должно отменить/обработать именно активные ордера).
   * Реализации обязаны делать поиск по marketId, а не по strategyId —
   * это исключает зависимость от конвенции «strategyId == String(marketId)».
   * Фильтрация по «открытым» должна быть одинаковой независимо от того, какой
   * внутренний путь реализация использует для поиска (по marketCatalog или
   * по legacy-конвенции) — см. `getByStrategyId()`, с которым семантика
   * «открытые» должна совпадать.
   */
  getByMarketId(marketId: MarketId): Promise<readonly Order[]>;

  /**
   * Возвращает ВСЕ ордера в хранилище — включая терминальные, ещё не удалённые
   * cleanup-путём (`deleteIfState`/`deleteIfVersion`).
   *
   * @returns Promise с readonly массивом всех сохранённых ордеров
   *
   * @remarks
   * НЕ фильтрует по статусу — в отличие от `getByStrategyId()`/`getByMarketId()`.
   * Используется OrderReconciler для сверки локальных ордеров с venue и
   * итоговой отчётности бектеста — обоим нужна полная картина хранилища,
   * а не только активные ордера. Для открытых ордеров одной стратегии
   * используй `getByStrategyId()`.
   */
  getAll(): Promise<readonly Order[]>;
}
