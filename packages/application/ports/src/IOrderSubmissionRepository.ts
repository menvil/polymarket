/**
 * Порт: submission guard + reservation journal по clientOrderId.
 *
 * @remarks
 * ### Зачем нужен:
 * Повторный `PlaceOrderUseCase.execute()` с тем же `input.orderId`/`clientOrderId`
 * (retry после таймаута, дубль команды) может получить от venue ТОТ ЖЕ
 * `venueOrderId` (идемпотентность биржи по clientOrderId). Если первый вызов уже
 * сохранил Order, второй попадёт в CAS save-conflict и сделает rollback cancel
 * этого `venueOrderId`, потенциально отменив УСПЕШНО созданный ордер.
 *
 * Этот репозиторий фиксирует статус submission ПО `clientOrderId` и позволяет
 * `PlaceOrderUseCase` (под keyed mutex) отличить: (a) уже закоммиченный submit
 * → вернуть тот же venueOrderId без повторного submit/cancel; (b) submission в
 * процессе; (c) ambiguous/unknown submission → не retry-ить автоматически;
 * (d) venue-принятый, но локально ещё не сохранённый ордер (`VENUE_ACCEPTED`);
 * (e) повторное использование того же clientOrderId с ДРУГИМИ параметрами
 * (`FINGERPRINT_MISMATCH`).
 *
 * ### Теперь это ещё и reservation journal:
 * Кроме idempotency-статуса запись хранит **экономические параметры заявки**
 * (`side`, `orderPrice`, `requestedSize`, `effectiveSize`) и **учёт резервации**
 * ({@link ReservationSnapshot}: initial/remaining/consumed/released/status). Это
 * даёт recovery-путь: когда приходит Fill на ambiguous submit БЕЗ локального
 * Order (`ProcessFillUseCase`), по `venueOrderId` (см. {@link IOrderSubmissionRepository.findByVenueOrderId})
 * находится held-резервация и потребляется корректно — без двойного дебета
 * available и без замороженного капитала.
 *
 * ### Что это НЕ:
 * Это operational guard + reservation journal, а НЕ доменный Order и НЕ replacement
 * для Order-репозитория. Он хранит lifecycle факта «мы отправляли ордер под этим
 * clientOrderId, что из этого вышло, и что стало с зарезервированным капиталом».
 *
 * ### Durability:
 * In-memory реализация НЕ переживает process restart (в отличие от будущего
 * персистентного адаптера с DB-транзакцией). Runtime-валидация повреждённых
 * записей (`COMMITTED`/`VENUE_ACCEPTED` без `venueOrderId`) всё равно обязательна —
 * персистентный адаптер может вернуть повреждённые данные (см. Stage 5 в
 * `docs/architecture/ordered-event-outbox.md`).
 *
 * ### Идемпотентность/atomicity:
 * `begin()` атомарно резервирует clientOrderId под submission (аналог
 * `IProcessedFillRepository.begin`). Реализация обязана вызываться ВНУТРИ того
 * же keyed mutex, что и PlaceOrderUseCase, чтобы `begin → submit → markVenueAccepted
 * → markCommitted` не пересекались для одного clientOrderId. `applyReservationTransition`
 * идемпотентен по `operationId` (fill ID / cancel-op ID) — повторный вызов не
 * удваивает учёт.
 *
 * ### Fingerprint:
 * `begin()` принимает детерминированный `fingerprint` параметров ордера
 * (account/instrument/asset/side/price/size/orderType/postOnly/strategyId).
 * Если запись под тем же `clientOrderId` существует с ДРУГИМ fingerprint —
 * `begin()` возвращает `FINGERPRINT_MISMATCH`: значит `clientOrderId`
 * переиспользован под другой ордер, и возвращать `ALREADY_COMMITTED` было бы
 * опасно (вернули бы чужой venueOrderId).
 *
 * @example
 * ```typescript
 * const begin = await submissions.begin({
 *   clientOrderId, accountId, instrumentId, fingerprint,
 *   side: 'BUY', orderPrice: '0.65', requestedSize: '100', now,
 * });
 * if (begin.outcome === 'ALREADY_COMMITTED') return Ok(begin.record.venueOrderId!);
 * // ... после успешного reserve:
 * await submissions.markReservationHeld(clientOrderId, notional.toString(), now);
 * // ... после успешного submit до local save:
 * await submissions.markVenueAccepted(clientOrderId, venueOrderId, now);
 * // ... после local save:
 * await submissions.markCommitted(clientOrderId, venueOrderId, now);
 * ```
 */
import type { Result } from '@polymarket/result';
import type { AccountId, InstrumentId, OrderId } from '@polymarket/ids';
import type {
  OrderSide,
  ReservationSnapshot,
  ReservationStatus,
  ReservationTransitionError,
} from './reservationJournal.js';

/**
 * Статус submission по clientOrderId.
 *
 * @remarks
 * - `SUBMITTING` — `begin()` зарезервировал, submit в процессе (не завершён).
 * - `VENUE_ACCEPTED` — venue вернул `venueOrderId` (ордер создан на бирже),
 *   но локальный Order ещё не сохранён. Промежуточное состояние между submit
 *   и save: если крэш/сбой между ними, guard знает, что venue-ордер существует.
 * - `COMMITTED` — Order успешно сохранён локально (есть `venueOrderId`).
 * - `UNKNOWN` — ambiguous исход (MAY_HAVE_BEEN_SUBMITTED / UNKNOWN submit):
 *   venue-ордер мог быть создан, автоматический retry НЕ разрешён.
 * - `FAILED` — submit точно не создал ордер (DEFINITELY_NOT_SUBMITTED / REJECTED):
 *   retry допустим (см. `BeginOrderSubmissionResult.FAILED_RETRYABLE`).
 * - `CANCELLED` — venue-ордер ДЕЙСТВИТЕЛЬНО существовал и был операторски
 *   отменён (подтверждённый cancel живого venue-ордера, см.
 *   `CancelBoundVenueOrderUseCase`): retry ПОД ТЕМ ЖЕ clientOrderId запрещён
 *   НАВСЕГДА (см. `BeginOrderSubmissionResult.CANCELLED_NO_RESUBMIT`) — в
 *   отличие от `FAILED`, здесь ордер был создан, поэтому переиспользование
 *   clientOrderId для нового submit было бы некорректной idempotency-семантикой.
 *   Новый ордер обязан использовать НОВЫЙ clientOrderId.
 */
export type OrderSubmissionStatus =
  | 'SUBMITTING'
  | 'VENUE_ACCEPTED'
  | 'COMMITTED'
  | 'UNKNOWN'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Запись о submission + reservation journal по clientOrderId.
 *
 * @remarks
 * ### Инвариант venueOrderId:
 * Для `status ∈ {VENUE_ACCEPTED, COMMITTED}` `venueOrderId` ОБЯЗАН быть задан
 * (venue создал ордер). Compile-time это не выражено как discriminated union
 * (чтобы не раздувать blast radius переходов), поэтому caller ОБЯЗАН делать
 * runtime-проверку — см. `PlaceOrderUseCase` (Stage 5): повреждённая
 * `COMMITTED`/`VENUE_ACCEPTED` запись без `venueOrderId` → hard error, НЕ новый submit.
 */
export interface OrderSubmissionRecord {
  readonly clientOrderId: OrderId;
  readonly venueOrderId?: OrderId;
  readonly status: OrderSubmissionStatus;
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  /**
   * Номер попытки submission.
   *
   * @remarks
   * Новая запись начинается с `attempt = 1`; безопасный retry после `FAILED`
   * (reservation `NONE` либо `SETTLED` с `remaining === '0'`) увеличивает
   * attempt в `begin()`. Все reservation operation IDs ОБЯЗАНЫ включать attempt
   * (`attempt:${attempt}:...`) — иначе операции разных попыток одного
   * clientOrderId ошибочно считались бы дубликатами (идемпотентность по
   * operationId «съела» бы rollback второй попытки).
   */
  readonly attempt: number;
  /** Детерминированный fingerprint параметров ордера (см. doc порта). */
  readonly fingerprint: string;
  /** Сторона заявки (определяет kind резервации: BUY→USDC, SELL→TOKENS). */
  readonly side: OrderSide;
  /**
   * Сериализованный AssetId заявки (`assetIdToString`), опционально.
   *
   * @remarks
   * Сохраняется в `begin()` — вместе с side/price/size даёт достаточно данных
   * для восстановления доменного Order из привязанного live venue-ордера
   * (recovery после операторского BIND_VENUE_ORDER/OPEN_ORDER). Optional для
   * совместимости со старыми записями.
   */
  readonly assetId?: string;
  /** ID стратегии заявки (для восстановления Order), опционально. */
  readonly strategyId?: string;
  /** Цена ордера (exact decimal-строка) — для recovery-расчёта fill. */
  readonly orderPrice: string;
  /** Запрошенный размер (exact decimal-строка). */
  readonly requestedSize: string;
  /** Фактический размер, если venue скорректировал (exact decimal-строка). */
  readonly effectiveSize?: string;
  /** Учёт резервации капитала под этот ордер. */
  readonly reservation: ReservationSnapshot;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly reason?: string;
}

/**
 * Результат `begin()`.
 *
 * @remarks
 * - `ACQUIRED` — новая submission (или после FAILED — retry): caller продолжает submit.
 * - `ALREADY_COMMITTED` — под этим clientOrderId уже есть committed Order:
 *   caller возвращает `record.venueOrderId` без повторного submit/cancel.
 * - `VENUE_ACCEPTED` — прошлый submit получил venueOrderId, но local save не
 *   завершился (крэш между submit и save): caller НЕ submit-ит повторно;
 *   пытается восстановить/зареконсилить существующий venue-ордер.
 * - `IN_PROGRESS` — submission уже идёт (`SUBMITTING`): caller возвращает Err
 *   («submission in progress»), не запускает второй submit.
 * - `UNKNOWN` — прошлый submit был ambiguous: caller возвращает Err и НЕ
 *   retry-ит автоматически (нужна ручная реконсиляция).
 * - `FAILED_RETRYABLE` — прошлый submit точно не создал ордер И reservation в
 *   безопасном состоянии (`NONE`, либо `SETTLED` с `remaining === '0'`): caller
 *   продолжает (begin переводит запись в `SUBMITTING` и увеличивает `attempt`).
 * - `RECONCILIATION_REQUIRED` — прошлый submit `FAILED`, но reservation НЕ в
 *   безопасном состоянии (`HELD`/`PARTIALLY_SETTLED`/`RECONCILIATION_REQUIRED`
 *   либо `remaining > 0`): retry ЗАПРЕЩЁН — повторный reserve поверх
 *   неснятой резервации заморозил бы капитал дважды. Caller НЕ выполняет
 *   risk/reserve/submit, создаёт reconciliation issue и возвращает Err.
 * - `FINGERPRINT_MISMATCH` — clientOrderId переиспользован под ДРУГИЕ параметры:
 *   caller возвращает Err и создаёт issue, НЕ submit/cancel/release.
 * - `CANCELLED_NO_RESUBMIT` — прошлый venue-ордер под этим clientOrderId был
 *   подтверждённо отменён оператором (`markCancelled`): retry НАВСЕГДА
 *   запрещён под тем же clientOrderId (в отличие от `FAILED_RETRYABLE`) —
 *   caller возвращает Err, требует новый clientOrderId для нового ордера.
 */
export type BeginOrderSubmissionResult =
  | { readonly outcome: 'ACQUIRED' }
  | { readonly outcome: 'ALREADY_COMMITTED'; readonly record: OrderSubmissionRecord }
  | { readonly outcome: 'VENUE_ACCEPTED'; readonly record: OrderSubmissionRecord }
  | { readonly outcome: 'IN_PROGRESS'; readonly record: OrderSubmissionRecord }
  | { readonly outcome: 'UNKNOWN'; readonly record: OrderSubmissionRecord }
  | { readonly outcome: 'FAILED_RETRYABLE'; readonly record: OrderSubmissionRecord }
  | { readonly outcome: 'RECONCILIATION_REQUIRED'; readonly record: OrderSubmissionRecord }
  | { readonly outcome: 'CANCELLED_NO_RESUBMIT'; readonly record: OrderSubmissionRecord }
  | {
      readonly outcome: 'FINGERPRINT_MISMATCH';
      readonly record: OrderSubmissionRecord;
      readonly expectedFingerprint: string;
      readonly actualFingerprint: string;
    };

/** Репозиторий submission guard. */
export interface IOrderSubmissionRepository {
  /**
   * Атомарно резервирует clientOrderId под submission (reservation `NONE`).
   *
   * @param input - `clientOrderId`, `accountId`, `instrumentId`, `fingerprint`,
   *   экономические параметры (`side`, `orderPrice`, `requestedSize`), `now`
   * @returns `BeginOrderSubmissionResult` (см. типы)
   *
   * @remarks
   * Новая запись создаётся с `reservation.status = 'NONE'`. Резервация
   * помечается held отдельно (`markReservationHeld`) — ПОСЛЕ успешного
   * `PortfolioService.reserve...`.
   */
  begin(input: {
    readonly clientOrderId: OrderId;
    readonly accountId: AccountId;
    readonly instrumentId: InstrumentId;
    readonly fingerprint: string;
    readonly side: OrderSide;
    readonly orderPrice: string;
    readonly requestedSize: string;
    /** Сериализованный AssetId (`assetIdToString`) — для recovery Order. */
    readonly assetId?: string;
    /** ID стратегии — для recovery Order. */
    readonly strategyId?: string;
    readonly now: Date;
  }): Promise<BeginOrderSubmissionResult>;

  /**
   * Помечает резервацию как полностью held (после успешного reserve в Portfolio).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param initial - Зарезервированное количество (exact decimal-строка):
   *   USDC-notional для BUY, размер токенов для SELL
   * @param now - Текущее время (updatedAt)
   * @returns `Ok(record)` или `Err(ReservationTransitionError)` если запись не
   *   найдена либо переход запрещён
   *
   * @remarks
   * Устанавливает `reservation = { initial, remaining: initial, consumed: 0,
   * released: 0, status: HELD }`.
   *
   * ### Разрешённые переходы (все остальные → `Err`):
   * - `NONE → HELD` — первая резервация попытки;
   * - `SETTLED → HELD` — ТОЛЬКО после увеличения `attempt` (новая попытка после
   *   подтверждённого rollback прошлой);
   * - `HELD → HELD` — только идемпотентно с ТЕМ ЖЕ `initial` (без потребления).
   *
   * Запрещено перезаписывать: `HELD` с другой суммой, `PARTIALLY_SETTLED`,
   * `RECONCILIATION_REQUIRED` — попытка затереть unresolved journal возвращает
   * `ReservationTransitionError`, caller ОБЯЗАН прервать submit.
   */
  markReservationHeld(
    clientOrderId: OrderId,
    initial: string,
    now: Date,
  ): Promise<Result<OrderSubmissionRecord, ReservationTransitionError>>;

  /**
   * Фиксирует фактический размер, если venue его скорректировал.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param effectiveSize - Фактический размер (exact decimal-строка)
   * @param now - Текущее время
   */
  setEffectiveSize(clientOrderId: OrderId, effectiveSize: string, now: Date): Promise<void>;

  /**
   * Применяет reservation transition (consume/release/статус), идемпотентно по operationId.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param transition - `operationId` (fill ID / cancel-op ID), `consume?`,
   *   `release?`, `status?`, `now`
   * @returns `Ok(record)` с обновлённой резервацией, или `Err` при нарушении
   *   инварианта учёта (over-consume, отрицательная сумма)
   *
   * @remarks
   * Повторный вызов с уже применённым `operationId` — no-op (возвращает текущую
   * запись Ok), НЕ удваивает consumed/released. Проверяет инвариант
   * `initial = remaining + consumed + released`.
   */
  applyReservationTransition(
    clientOrderId: OrderId,
    transition: {
      readonly operationId: string;
      readonly consume?: string;
      readonly release?: string;
      readonly status?: ReservationStatus;
      readonly now: Date;
    },
  ): Promise<Result<OrderSubmissionRecord, ReservationTransitionError>>;

  /**
   * Обратный поиск записи по venueOrderId.
   *
   * @param venueOrderId - venue orderId
   * @returns Запись или `undefined`
   *
   * @remarks
   * Нужен `ProcessFillUseCase`: Fill приходит с `venueOrderId` (не clientOrderId),
   * а recovery held-резервации требует найти execution journal. Один venueOrderId
   * не может принадлежать двум clientOrderId (реализация обязана это гарантировать).
   */
  findByVenueOrderId(venueOrderId: OrderId): Promise<OrderSubmissionRecord | undefined>;

  /**
   * Помечает submission как VENUE_ACCEPTED (venue вернул venueOrderId, local save ещё нет).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param venueOrderId - venue orderId, полученный от биржи
   * @param now - Текущее время (updatedAt)
   *
   * @remarks
   * Вызывается СРАЗУ после успешного submit, ДО local Order create/save.
   * Если между этим и `markCommitted` произойдёт крэш — при рестарте `begin()`
   * вернёт `VENUE_ACCEPTED`, и caller не сделает повторный submit.
   */
  markVenueAccepted(clientOrderId: OrderId, venueOrderId: OrderId, now: Date): Promise<void>;

  /**
   * Помечает submission как успешно закоммиченную (Order сохранён локально).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param venueOrderId - venue orderId сохранённого Order
   * @param now - Текущее время (updatedAt)
   */
  markCommitted(clientOrderId: OrderId, venueOrderId: OrderId, now: Date): Promise<void>;

  /**
   * Помечает submission как ambiguous (venue-ордер мог быть создан).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param reason - Причина ambiguity
   * @param venueOrderId - venue orderId, если известен (опционально)
   * @param now - Текущее время
   */
  markUnknown(clientOrderId: OrderId, reason: string, venueOrderId: OrderId | undefined, now: Date): Promise<void>;

  /**
   * Помечает submission как провалившуюся (ордер точно не создан, retry допустим).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param reason - Причина
   * @param now - Текущее время
   */
  markFailed(clientOrderId: OrderId, reason: string, now: Date): Promise<void>;

  /**
   * Помечает submission как `CANCELLED` (venue-ордер существовал и был
   * операторски отменён — retry под этим clientOrderId запрещён навсегда).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param reason - Причина (audit, обычно включает operatorId/время)
   * @param now - Текущее время
   *
   * @remarks
   * В отличие от `markFailed` (retry разрешён после `FAILED` + безопасная
   * резервация), `CANCELLED` — терминальный статус: `begin()` под тем же
   * clientOrderId ВСЕГДА возвращает `CANCELLED_NO_RESUBMIT`, независимо от
   * состояния резервации. Используется `CancelBoundVenueOrderUseCase` после
   * подтверждённой venue-отмены живого ордера без локального Order.
   */
  markCancelled(clientOrderId: OrderId, reason: string, now: Date): Promise<void>;

  /**
   * Возвращает текущую запись submission по clientOrderId.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @returns Запись или `undefined`, если clientOrderId неизвестен
   */
  get(clientOrderId: OrderId): Promise<OrderSubmissionRecord | undefined>;

  /**
   * Возвращает все записи с указанным статусом submission.
   *
   * @param status - Статус (например `UNKNOWN` для reconciler'а ambiguous submits)
   * @returns Snapshot-массив записей (пустой, если таких нет)
   *
   * @remarks
   * Нужен `ReconcileUnknownSubmissionsUseCase`: ambiguous submit БЕЗ
   * venueOrderId невозможно найти через `findByVenueOrderId` — reconciler
   * перебирает `UNKNOWN`-записи и осторожно сопоставляет их с venue open
   * orders/trades, чтобы привязать venueOrderId либо освободить резервацию.
   */
  listByStatus(status: OrderSubmissionStatus): Promise<readonly OrderSubmissionRecord[]>;
}
