/**
 * Порт: синхронное чтение ордеров для стратегий.
 *
 * @remarks
 * В отличие от `IOrderRepository` (async), `IOrderStateStore` предоставляет
 * синхронный доступ к ордерам для StrategyScheduler и стратегий.
 *
 * Все данные in-memory, O(1) / O(n) без async overhead.
 * Используется StrategyScheduler при сборке StrategySnapshot.
 *
 * Реализации:
 * - InMemoryOrderRepository (Phase 1) — бектест
 *
 * @example
 * ```typescript
 * const orders = store.getOpenOrdersByInstrument('strategy-1', instrumentId);
 * const order = store.getOrder(orderId);
 * ```
 */
import type { Order } from '@polymarket/order';
import type { OrderId, InstrumentId } from '@polymarket/ids';

export interface IOrderStateStore {
  /**
   * Возвращает все открытые ордера стратегии.
   *
   * @param strategyId - ID стратегии
   * @returns Readonly массив ордеров стратегии
   */
  getOpenOrders(strategyId: string): readonly Order[];

  /**
   * Возвращает ордера стратегии на конкретном инструменте.
   *
   * @param strategyId - ID стратегии
   * @param instrumentId - ID инструмента (tokenId)
   * @returns Readonly массив ордеров
   *
   * @remarks
   * Используется StrategyScheduler при сборке snapshot.
   */
  getOpenOrdersByInstrument(strategyId: string, instrumentId: InstrumentId): readonly Order[];

  /**
   * Возвращает ордер по ID или undefined.
   *
   * @param orderId - ID ордера
   * @returns Order или undefined
   */
  getOrder(orderId: OrderId): Order | undefined;

  /**
   * Синхронно сохраняет (перезаписывает) ордер в хранилище.
   *
   * @param order - Order для сохранения
   *
   * @remarks
   * Используется в `ProcessFillUseCase` для атомарного обновления
   * состояния ордера до portfolio update — без yield-окна между ними.
   * Это предотвращает race condition, когда стратегия видит position>0
   * но ордер ещё OPEN → шлёт CANCEL → "Cannot unfreeze".
   */
  saveSync(order: Order): void;

  /**
   * Помечает ордер как MATCHED на бирже.
   *
   * @param orderId - ID ордера
   *
   * @remarks
   * Вызывается при получении WS-события `status=MATCHED` от Polymarket.
   * После пометки `CancelOrderUseCase` пропускает отмену этого ордера:
   * MATCHED означает, что ордер уже исполнен на бирже и отмена невозможна.
   * Предотвращает race condition: partial fill → стратегия отменяет →
   * оставшийся fill приходит на "не найден" ордер → portfolio desync.
   */
  markMatchedOnExchange(orderId: OrderId): void;

  /**
   * Возвращает true если ордер помечен как MATCHED на бирже.
   *
   * @param orderId - ID ордера
   * @returns true если WS сообщил MATCHED для этого ордера
   */
  isMatchedOnExchange(orderId: OrderId): boolean;

  /**
   * Снимает пометку MATCHED с ордера.
   *
   * @param orderId - ID ордера
   *
   * @remarks
   * Вызывается после обработки CONFIRMED fill в ProcessFillUseCase.
   * CONFIRMED = fill осел on-chain (finality) → опасность "in-flight" миновала.
   *
   * Если другой fill для того же ордера ещё в пути (MATCHED),
   * следующее MATCHED-событие заново поставит флаг.
   *
   * Без очистки ордер навсегда остаётся в `matchedOrders` snapshot'а —
   * стратегия возвращает HOLD на каждом тике, не может ни продать, ни купить.
   */
  clearMatchedOnExchange(orderId: OrderId): void;
}
