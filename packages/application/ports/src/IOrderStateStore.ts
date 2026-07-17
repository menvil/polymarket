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
 * On-chain статус in-flight fill.
 *
 * @remarks
 * Жизненный цикл fill на Polymarket: `MATCHED` (ордера сведены) → `MINED`
 * (транзакция в блоке) → `CONFIRMED` (finality) либо `FAILED` (revert).
 * Пометка (`markInFlightFill`) допустима только в не-терминальных статусах
 * `MATCHED`/`MINED`; `CONFIRMED`/`FAILED` выставляются через
 * `updateInFlightFillStatus()` перед снятием записи (`clearInFlightFill`).
 */
export type InFlightFillStatus = 'MATCHED' | 'MINED' | 'CONFIRMED' | 'FAILED';

/**
 * In-flight fill: fill получил on-chain подтверждение (MATCHED/MINED),
 * но ещё не достиг finality (CONFIRMED) или не завершился (FAILED).
 */
export interface InFlightFill {
  readonly fillId: FillId;
  readonly orderId: OrderId;
  readonly instrumentId: InstrumentId;
  /** On-chain статус на момент последней пометки/обновления (всегда известен). */
  readonly status: InFlightFillStatus;
}

/**
 * Входные данные `markInFlightFill()`.
 *
 * @remarks
 * `status` ограничен `MATCHED | MINED`: пометить fill как in-flight можно
 * только в не-терминальном статусе. Терминальные `CONFIRMED`/`FAILED`
 * выставляются отдельно через `updateInFlightFillStatus()` — семантически
 * это уже не «новый in-flight fill», а завершение существующего.
 */
export interface MarkInFlightFillInput {
  readonly instrumentId: InstrumentId;
  readonly fillId: FillId;
  readonly orderId: OrderId;
  readonly status: Extract<InFlightFillStatus, 'MATCHED' | 'MINED'>;
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

/**
 * Application-level статус обработки fill (ОТДЕЛЬНАЯ ось от venue on-chain
 * {@link InFlightFillStatus}).
 *
 * @remarks
 * `InFlightFillStatus` описывает venue-жизненный цикл (MATCHED→MINED→CONFIRMED/
 * FAILED). `FillProcessingStatus` описывает, довёл ли ProcessFillUseCase обработку
 * до конца:
 * - `PROCESSING` — обработка начата (под lock), ещё не завершена.
 * - `FAILED_RETRYABLE` — обработка упала ДО commit (order.applyFill), retry поможет.
 * - `RECONCILIATION_REQUIRED` — частичный commit (Portfolio/Ledger/journal desync),
 *   retry НЕ поможет, нужна ручная реконсиляция.
 *
 * Блок НЕ снимается автоматически при retryable/reconciliation — только при
 * реально settled обработке (APPLIED) либо явной ручной очистке.
 */
export type FillProcessingStatus = 'PROCESSING' | 'FAILED_RETRYABLE' | 'RECONCILIATION_REQUIRED';

/** Application-level блок обработки fill (см. {@link FillProcessingStatus}). */
export interface FillProcessingBlock {
  readonly fillId: FillId;
  readonly orderId: OrderId;
  readonly instrumentId: InstrumentId;
  readonly status: FillProcessingStatus;
}

/** Входные данные `markFillProcessing()`. */
export interface MarkFillProcessingInput {
  readonly fillId: FillId;
  readonly orderId: OrderId;
  readonly instrumentId: InstrumentId;
}

/**
 * Manual reconciliation block — типизированный блок ручной реконсиляции
 * (ОТДЕЛЬНАЯ ось от venue in-flight fills и fill processing-блоков).
 *
 * @remarks
 * Ставится use-case'ами при частичном commit, когда Portfolio↔journal desync
 * не может быть разрешён автоматически (journal release упал после успешного
 * Portfolio release; CAS conflict после подтверждённого venue cancel и т.п.).
 *
 * ### Почему НЕ pendingMatchFillId/MATCHED placeholder:
 * MATCHED placeholder означает «fill ожидается и разрешит состояние» — его
 * снимает первый реальный fill (`clearInFlightFill`/`clearOrderFillMatched`).
 * Manual block означает противоположное: «состояние разрешает ТОЛЬКО человек» —
 * реальный fill НЕ должен его снимать (и сам обязан блокироваться), иначе
 * задержанный fill на desync-ордере потребил бы чужой reserved-капитал и
 * заодно снял бы блок. Снятие — только явный `clearManualReconciliationBlock`
 * (оператор/recovery-тулинг после реконсиляции).
 */
export interface ManualReconciliationBlock {
  readonly orderId: OrderId;
  readonly instrumentId: InstrumentId;
  /** Причина блока (English, для оператора). */
  readonly reason: string;
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
  // TODO(unit-of-work): replace saveSync with CAS-aware UnitOfWork / atomic
  // Order+Portfolio commit. saveSync is a pragmatic single-process guard,
  // not a multi-aggregate transaction.
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
   * @param input - `{ instrumentId, fillId, orderId, status }`;
   *   `status` — только не-терминальные `MATCHED`/`MINED` (см. `MarkInFlightFillInput`)
   *
   * @remarks
   * Трекинг на уровне инструмента (а не ордера) через identity fillId, а не
   * счётчик — решает проблему: после cancel ордер удалён из repo, но fill
   * в пути on-chain. `hasMatchedFills(orderId)` не поможет — ордера нет в
   * `getOpenOrdersByInstrument`. `hasInFlightFills(instrumentId)` работает
   * независимо от состояния ордера.
   *
   * Идемпотентен по fillId: повторная пометка того же fillId (дублирующееся
   * WS-событие) не создаёт вторую запись и не «удваивает» in-flight состояние —
   * существующая запись обновляется на переданный `input.status` (например,
   * MATCHED → MINED при повторном событии более позднего статуса).
   */
  markInFlightFill(input: MarkInFlightFillInput): void;

  /**
   * Обновляет статус уже отслеживаемого in-flight fill.
   *
   * @param fillId - ID fill-события, ранее переданный в `markInFlightFill`
   * @param status - Новый on-chain статус (включая терминальные CONFIRMED/FAILED)
   *
   * @remarks
   * Неизвестный fillId — no-op (безопасно: fill уже снят через
   * `clearInFlightFill` или никогда не помечался). Обновление статуса НЕ
   * снимает запись — терминальный статус (`CONFIRMED`/`FAILED`) фиксируется
   * для наблюдаемости, а снятие остаётся явным `clearInFlightFill(fillId)`.
   */
  updateInFlightFillStatus(fillId: FillId, status: InFlightFillStatus): void;

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
   * @returns Readonly массив `InFlightFill` (пустой, если in-flight fills нет);
   *   `status` заполнен всегда (не optional)
   */
  getInFlightFills(instrumentId: InstrumentId): readonly InFlightFill[];

  // ── Application-level fill processing blocks (Stage 6) ──────────────────────

  /**
   * Ставит application-level processing-блок (`PROCESSING`) на fill.
   *
   * @param input - `{ fillId, orderId, instrumentId }`
   *
   * @remarks
   * Вызывается ProcessFillUseCase в начале обработки под lock. Идемпотентен по
   * fillId. Блок отражает «обработка ещё не settled» и участвует в
   * {@link IOrderStateStore.hasUnsettledFills}.
   */
  markFillProcessing(input: MarkFillProcessingInput): void;

  /**
   * Обновляет статус processing-блока (PROCESSING → FAILED_RETRYABLE /
   * RECONCILIATION_REQUIRED).
   *
   * @param fillId - ID fill
   * @param status - Новый статус
   *
   * @remarks
   * Неизвестный fillId — no-op. НЕ снимает блок (снятие — только
   * `clearFillProcessing` на settled/manual).
   */
  updateFillProcessingStatus(fillId: FillId, status: FillProcessingStatus): void;

  /**
   * Снимает processing-блок с fill (только на реально settled обработке / manual).
   *
   * @param fillId - ID fill
   *
   * @remarks
   * Неизвестный fillId — no-op. НЕ вызывается на FAILED_RETRYABLE/
   * RECONCILIATION_REQUIRED (блок должен сохраняться).
   */
  clearFillProcessing(fillId: FillId): void;

  /**
   * Есть ли на инструменте хотя бы один processing-блок.
   *
   * @param instrumentId - ID инструмента
   * @returns true если есть незавершённый/заблокированный fill
   */
  hasFillProcessingBlocks(instrumentId: InstrumentId): boolean;

  /**
   * Возвращает все processing-блоки инструмента.
   *
   * @param instrumentId - ID инструмента
   * @returns Readonly массив `FillProcessingBlock`
   */
  getFillProcessingBlocks(instrumentId: InstrumentId): readonly FillProcessingBlock[];

  /**
   * Есть ли на инструменте НЕзавершённые fills (venue in-flight ЛИБО
   * application processing-блок ЛИБО manual reconciliation block).
   *
   * @param instrumentId - ID инструмента
   * @returns `hasInFlightFills(id) || hasFillProcessingBlocks(id) ||
   *   hasManualReconciliationBlocks(id)`
   *
   * @remarks
   * ЕДИНЫЙ guard для стратегий и cancel: блокирует новую активность, пока есть
   * хоть venue in-flight fill, хоть незавершённый application processing-блок
   * (FAILED_RETRYABLE/RECONCILIATION_REQUIRED), хоть manual reconciliation block.
   */
  hasUnsettledFills(instrumentId: InstrumentId): boolean;

  // ── Manual reconciliation blocks ─────────────────────────────────────────────

  /**
   * Ставит manual reconciliation block на ордер/инструмент.
   *
   * @param block - `{ orderId, instrumentId, reason }`
   *
   * @remarks
   * Идемпотентен по orderId (повторная пометка обновляет reason). Блок участвует
   * в {@link IOrderStateStore.hasUnsettledFills} и НЕ снимается fill-ами —
   * только явным `clearManualReconciliationBlock` (оператор/recovery-тулинг).
   */
  markManualReconciliationBlock(block: ManualReconciliationBlock): void;

  /**
   * Снимает manual reconciliation block с ордера (ТОЛЬКО ручная реконсиляция).
   *
   * @param orderId - ID ордера
   *
   * @remarks
   * Неизвестный orderId — no-op. НЕ вызывается автоматикой обработки fill.
   */
  clearManualReconciliationBlock(orderId: OrderId): void;

  /**
   * Есть ли manual reconciliation block на конкретном ордере.
   *
   * @param orderId - ID ордера
   * @returns true если блок стоит
   */
  hasManualReconciliationBlockForOrder(orderId: OrderId): boolean;

  /**
   * Есть ли на инструменте хотя бы один manual reconciliation block.
   *
   * @param instrumentId - ID инструмента
   * @returns true если есть блок(и)
   */
  hasManualReconciliationBlocks(instrumentId: InstrumentId): boolean;

  /**
   * Возвращает все manual reconciliation blocks инструмента.
   *
   * @param instrumentId - ID инструмента
   * @returns Readonly массив блоков (пустой, если блоков нет)
   */
  getManualReconciliationBlocks(instrumentId: InstrumentId): readonly ManualReconciliationBlock[];
}
