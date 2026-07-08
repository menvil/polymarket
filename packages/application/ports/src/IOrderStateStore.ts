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
 * ### fillId-based tracking (matched / in-flight):
 * Обе группы методов (`*OrderFillMatched`, `*InFlightFill*`) идентифицируют
 * каждый fill по его `FillId`, а не просто инкрементируют/декрементируют
 * общий счётчик или boolean-флаг на orderId/instrumentId. Это устраняет две
 * дыры старого API (`markMatchedOnExchange`/`isMatchedOnExchange`/
 * `clearMatchedOnExchange`, `markInFlightFill`/`hasInFlightFills`/
 * `clearInFlightFills`):
 * 1. Partial fills одного ордера/инструмента больше не «затирают» друг друга —
 *    clear одного fillId не трогает состояние другого.
 * 2. Повторное (дублирующееся) WS MATCHED-событие для уже отслеживаемого
 *    fillId идемпотентно (Map.set на существующий ключ), а не удваивает счётчик.
 *
 * `hasMatchedFills(orderId)` / `hasInFlightFills(instrumentId)` остаются
 * boolean-геттерами (обратная совместимость с существующими читателями —
 * StrategyScheduler, десятки стратегий через `StrategySnapshot`), но теперь
 * это производные от identity-based хранилища, а не от отдельного счётчика.
 *
 * @example
 * ```typescript
 * const orders = store.getOpenOrdersByInstrument('strategy-1', instrumentId);
 * const order = store.getOrder(orderId);
 * ```
 */
import type { Order } from '@polymarket/order';
import type { OrderId, InstrumentId, FillId } from '@polymarket/ids';
import { asFillId } from '@polymarket/ids';

/**
 * In-flight fill: fill получил on-chain подтверждение (MATCHED/MINED),
 * но ещё не достиг finality (CONFIRMED) или не завершился (FAILED).
 */
export interface InFlightFill {
  readonly fillId: FillId;
  readonly orderId: OrderId;
  readonly instrumentId: InstrumentId;
  /** On-chain статус на момент последней пометки (если известен). */
  readonly status?: 'MATCHED' | 'MINED' | 'CONFIRMED' | 'FAILED';
}

/**
 * Синтетический placeholder-FillId для сценариев, где биржа/venue сообщает
 * «ордер matched» (или «cancel отклонён — уже matched»), но конкретный fillId
 * ещё не известен на этом уровне (например, `PlaceOrderUseCase` — мгновенный
 * matched-ответ REST без данных fill; `CancelOrderUseCase` — matched выведен
 * из текста ошибки cancel, а не из fill-события).
 *
 * @param orderId - ID ордера, для которого нет конкретного fillId
 * @returns Детерминированный placeholder `FillId`, уникальный per-orderId
 *
 * @remarks
 * `clearOrderFillMatched(orderId, fillId)` ВСЕГДА дополнительно снимает
 * placeholder-запись для того же orderId (если она есть) — как только приходит
 * РЕАЛЬНЫЙ fillId для ордера, он «разрешает» более раннюю неоднозначную пометку.
 * Это гарантирует, что placeholder не протекает навсегда, даже если конкретный
 * fillId, под которым он был поставлен, никогда явно не совпадёт.
 */
export function pendingMatchFillId(orderId: OrderId): FillId {
  // Формат `pending-match:<orderId>` гарантированно проходит валидацию asFillId
  // (непустая строка без control-символов, < 256 символов).
  return asFillId(`pending-match:${String(orderId)}`)!;
}

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
   * Помечает конкретный fill ордера как matched на бирже.
   *
   * @param orderId - ID ордера
   * @param fillId - ID fill-события (или `pendingMatchFillId(orderId)`, если
   *   конкретный fillId ещё не известен — см. doc функции)
   *
   * @remarks
   * Вызывается при получении WS-события `status=MATCHED` от Polymarket.
   * После пометки `CancelOrderUseCase` пропускает отмену этого ордера, пока
   * `hasMatchedFills(orderId)` не станет `false` (см. `clearOrderFillMatched`).
   * Предотвращает race condition: partial fill → стратегия отменяет →
   * оставшийся fill приходит на "не найден" ордер → portfolio desync.
   *
   * Идемпотентен для повторного вызова с тем же (orderId, fillId).
   */
  markOrderFillMatched(orderId: OrderId, fillId: FillId): void;

  /**
   * Снимает пометку matched с конкретного fill ордера.
   *
   * @param orderId - ID ордера
   * @param fillId - ID fill-события, который был передан в `markOrderFillMatched`
   *
   * @remarks
   * Снимает ТОЛЬКО этот fillId — если у ордера есть другой ещё не подтверждённый
   * partial fill (другой fillId), его matched-состояние не затрагивается.
   * Дополнительно снимает placeholder-запись `pendingMatchFillId(orderId)` для
   * этого ордера (см. doc `pendingMatchFillId`).
   *
   * Вызывается после обработки CONFIRMED fill в `ProcessFillUseCase`.
   * CONFIRMED = fill осел on-chain (finality) → опасность "in-flight" миновала.
   *
   * Без очистки ордер навсегда остаётся «matched» — `hasMatchedFills(orderId)`
   * останется `true`, стратегия зависнет в HOLD.
   */
  clearOrderFillMatched(orderId: OrderId, fillId: FillId): void;

  /**
   * Возвращает true если у ордера есть хотя бы один matched (ещё не cleared) fill.
   *
   * @param orderId - ID ордера
   * @returns true если WS сообщил MATCHED хотя бы для одного fill этого ордера
   */
  hasMatchedFills(orderId: OrderId): boolean;

  /**
   * Возвращает все ID fill-ов, помеченных matched для данного ордера.
   *
   * @param orderId - ID ордера
   * @returns Readonly массив FillId (пустой, если matched-fill-ов нет)
   */
  getMatchedFillIds(orderId: OrderId): readonly FillId[];

  /**
   * Помечает конкретный fill как in-flight на уровне инструмента.
   *
   * @param instrumentId - ID инструмента
   * @param fillId - ID fill-события
   * @param orderId - ID ордера, к которому относится fill
   *
   * @remarks
   * Трекинг на уровне инструмента (а не ордера) через identity fillId, а не
   * счётчик — решает проблему: после cancel ордер удалён из repo, но fill
   * в пути on-chain. `hasMatchedFills(orderId)` не поможет — ордера нет в
   * `getOpenOrdersByInstrument`. `hasInFlightFills(instrumentId)` работает
   * независимо от состояния ордера.
   *
   * Идемпотентен: повторная пометка того же fillId (дублирующееся WS-событие)
   * не создаёт вторую запись и не «удваивает» in-flight состояние.
   */
  markInFlightFill(instrumentId: InstrumentId, fillId: FillId, orderId: OrderId): void;

  /**
   * Снимает in-flight пометку с конкретного fill по его FillId.
   *
   * @param fillId - ID fill-события, ранее переданный в `markInFlightFill`
   *
   * @remarks
   * Идентифицирует запись ПО fillId (не по instrumentId) — вызывающему коду
   * не нужно знать instrumentId на момент очистки. Если fillId неизвестен
   * (например, уже был снят, или никогда не помечался) — no-op, безопасно.
   * Снимает состояние ТОЛЬКО этого fill — другие in-flight fills того же
   * инструмента не затрагиваются.
   */
  clearInFlightFill(fillId: FillId): void;

  /**
   * Возвращает true если на инструменте есть хотя бы один in-flight fill.
   *
   * @param instrumentId - ID инструмента
   * @returns true если MATCHED/MINED fill в пути
   */
  hasInFlightFills(instrumentId: InstrumentId): boolean;

  /**
   * Возвращает все in-flight fills данного инструмента.
   *
   * @param instrumentId - ID инструмента
   * @returns Readonly массив `InFlightFill` (пустой, если in-flight fills нет)
   */
  getInFlightFills(instrumentId: InstrumentId): readonly InFlightFill[];
}
