/**
 * InMemoryOrderSubmissionRepository — submission guard + reservation journal в памяти.
 *
 * @remarks
 * Реализует `IOrderSubmissionRepository` на основе `Map<clientOrderId, record>`
 * плюс обратный индекс `Map<venueOrderId, clientOrderId>` и учёт применённых
 * reservation-операций `Map<clientOrderId, Set<operationId>>` (для идемпотентности
 * transitions).
 *
 * ### Семантика begin():
 * - Записи нет → `SUBMITTING` (attempt=1), reservation `NONE`, `{ outcome: 'ACQUIRED' }`.
 * - Fingerprint отличается от сохранённого → `{ outcome: 'FINGERPRINT_MISMATCH', ... }`
 *   (clientOrderId переиспользован под другой ордер — проверяется ПЕРВОЙ).
 * - `COMMITTED` → `{ outcome: 'ALREADY_COMMITTED', record }` (не трогаем).
 * - `VENUE_ACCEPTED` → `{ outcome: 'VENUE_ACCEPTED', record }` (не трогаем).
 * - `SUBMITTING` → `{ outcome: 'IN_PROGRESS', record }` (не трогаем).
 * - `UNKNOWN` → `{ outcome: 'UNKNOWN', record }` (не трогаем — не retry-им авто).
 * - `FAILED` + reservation безопасна (`NONE`, либо `SETTLED` с `remaining === 0`)
 *   → `SUBMITTING`, attempt+1, `{ outcome: 'FAILED_RETRYABLE', record: <prev> }`.
 * - `FAILED` + reservation НЕ безопасна (`HELD`/`PARTIALLY_SETTLED`/
 *   `RECONCILIATION_REQUIRED` либо `remaining > 0`) →
 *   `{ outcome: 'RECONCILIATION_REQUIRED', record }` (retry заблокирован —
 *   повторный reserve заморозил бы капитал дважды).
 *
 * ### Обратный индекс:
 * `markVenueAccepted`/`markCommitted`/`markUnknown` (с известным venue ID)
 * обновляют `_byVenue`. Один venueOrderId не может указывать на два clientOrderId
 * (при коллизии — бросаем: это баг вызывающего, не должно происходить под mutex).
 *
 * ### Отличие от production:
 * Production использует Redis/PostgreSQL (unique constraint + status + DB tx) для
 * multi-process, персистентности и restart durability. In-memory —
 * single-process/paper/backtest/тесты; НЕ переживает process restart.
 *
 * @example
 * ```typescript
 * const repo = new InMemoryOrderSubmissionRepository();
 * const begin = await repo.begin({ clientOrderId, accountId, instrumentId, fingerprint,
 *   side: 'BUY', orderPrice: '0.65', requestedSize: '100', now });
 * if (begin.outcome === 'ACQUIRED') {
 *   await repo.markReservationHeld(clientOrderId, '65', now); // reserve done
 *   // submit ... on success:
 *   await repo.markVenueAccepted(clientOrderId, venueOrderId, now);
 *   await repo.markCommitted(clientOrderId, venueOrderId, now);
 * }
 * ```
 */
import Decimal from 'decimal.js';
import type { AccountId, InstrumentId, OrderId } from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type {
  IOrderSubmissionRepository,
  OrderSubmissionRecord,
  BeginOrderSubmissionResult,
  OrderSide,
  ReservationStatus,
} from '@polymarket/ports';
import {
  ReservationTransitionError,
  emptyReservation,
  heldReservation,
  applyReservationDelta,
} from '@polymarket/ports';

/**
 * In-memory реализация submission guard + reservation journal.
 *
 * @remarks
 * Хранит запись по строковому ключу clientOrderId, обратный индекс venueOrderId→
 * clientOrderId и множество применённых reservation operationId. Возвращает
 * замороженные snapshot-копии. Не персистентна.
 */
export class InMemoryOrderSubmissionRepository implements IOrderSubmissionRepository {
  private readonly _records = new Map<string, OrderSubmissionRecord>();
  /** venueOrderId → clientOrderId (обратный индекс). */
  private readonly _byVenue = new Map<string, string>();
  /** clientOrderId → применённые reservation operationId (идемпотентность). */
  private readonly _appliedOps = new Map<string, Set<string>>();
  /**
   * clientOrderId → attempt, на котором резервация ПОСЛЕДНИЙ раз помечалась held.
   *
   * @remarks
   * Обеспечивает правило `SETTLED → HELD только после увеличения attempt`:
   * повторный `markReservationHeld` в рамках ТОЙ ЖЕ попытки поверх уже
   * settled-резервации запрещён (это затирание журнала, не новая попытка).
   */
  private readonly _heldAtAttempt = new Map<string, number>();

  /**
   * @param record - Исходная запись
   * @returns Замороженная snapshot-копия с клонированными Date и reservation
   */
  private _snapshot(record: OrderSubmissionRecord): OrderSubmissionRecord {
    return Object.freeze({
      ...record,
      reservation: Object.freeze({ ...record.reservation }),
      createdAt: new Date(record.createdAt.getTime()),
      updatedAt: new Date(record.updatedAt.getTime()),
    });
  }

  /**
   * Обновляет обратный индекс venueOrderId→clientOrderId.
   *
   * @param venueOrderId - venue orderId
   * @param clientOrderId - Клиентский ID ордера
   * @throws {Error} если venueOrderId уже привязан к другому clientOrderId
   */
  private _indexVenue(venueOrderId: OrderId, clientOrderId: OrderId): void {
    const vKey = String(venueOrderId);
    const cKey = String(clientOrderId);
    const existing = this._byVenue.get(vKey);
    if (existing !== undefined && existing !== cKey) {
      throw new Error(
        `venueOrderId ${vKey} already mapped to clientOrderId ${existing}, cannot remap to ${cKey}`,
      );
    }
    this._byVenue.set(vKey, cKey);
  }

  /**
   * Атомарно резервирует clientOrderId под submission.
   *
   * @param input - `clientOrderId`, `accountId`, `instrumentId`, `fingerprint`,
   *   `side`, `orderPrice`, `requestedSize`, `now`
   * @returns `BeginOrderSubmissionResult` (см. doc порта)
   */
  public async begin(input: {
    readonly clientOrderId: OrderId;
    readonly accountId: AccountId;
    readonly instrumentId: InstrumentId;
    readonly fingerprint: string;
    readonly side: OrderSide;
    readonly orderPrice: string;
    readonly requestedSize: string;
    readonly now: Date;
  }): Promise<BeginOrderSubmissionResult> {
    const key = String(input.clientOrderId);
    const existing = this._records.get(key);

    if (existing) {
      // Fingerprint-проверка ПЕРВОЙ: clientOrderId переиспользован под другой
      // ордер — возвращать ALREADY_COMMITTED было бы опасно (чужой venueOrderId).
      if (existing.fingerprint !== input.fingerprint) {
        return {
          outcome: 'FINGERPRINT_MISMATCH',
          record: this._snapshot(existing),
          expectedFingerprint: existing.fingerprint,
          actualFingerprint: input.fingerprint,
        };
      }
      if (existing.status === 'COMMITTED') {
        return { outcome: 'ALREADY_COMMITTED', record: this._snapshot(existing) };
      }
      if (existing.status === 'VENUE_ACCEPTED') {
        return { outcome: 'VENUE_ACCEPTED', record: this._snapshot(existing) };
      }
      if (existing.status === 'SUBMITTING') {
        return { outcome: 'IN_PROGRESS', record: this._snapshot(existing) };
      }
      if (existing.status === 'UNKNOWN') {
        return { outcome: 'UNKNOWN', record: this._snapshot(existing) };
      }
      // FAILED: retry разрешён ТОЛЬКО если резервация в безопасном состоянии —
      // NONE, либо SETTLED с remaining === 0. HELD/PARTIALLY_SETTLED/
      // RECONCILIATION_REQUIRED (или любой remaining > 0) означает, что прошлая
      // резервация не подтверждённо снята: повторный reserve заморозил бы
      // капитал дважды → RECONCILIATION_REQUIRED (retry заблокирован).
      const reservation = existing.reservation;
      const reservationSafeForRetry =
        reservation.status === 'NONE' ||
        (reservation.status === 'SETTLED' && new Decimal(reservation.remaining).isZero());
      if (!reservationSafeForRetry) {
        return { outcome: 'RECONCILIATION_REQUIRED', record: this._snapshot(existing) };
      }
      // Безопасный retry: переводим в SUBMITTING, увеличиваем attempt,
      // возвращаем прежнюю запись.
      const prev = this._snapshot(existing);
      this._records.set(key, this._snapshot({
        ...existing,
        status: 'SUBMITTING',
        attempt: existing.attempt + 1,
        updatedAt: input.now,
        reason: undefined,
      }));
      return { outcome: 'FAILED_RETRYABLE', record: prev };
    }

    this._records.set(key, this._snapshot({
      clientOrderId: input.clientOrderId,
      status: 'SUBMITTING',
      accountId: input.accountId,
      instrumentId: input.instrumentId,
      attempt: 1,
      fingerprint: input.fingerprint,
      side: input.side,
      orderPrice: input.orderPrice,
      requestedSize: input.requestedSize,
      reservation: emptyReservation(input.side === 'BUY' ? 'USDC' : 'TOKENS'),
      createdAt: input.now,
      updatedAt: input.now,
    }));
    return { outcome: 'ACQUIRED' };
  }

  /**
   * Помечает резервацию held (после успешного reserve в Portfolio).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param initial - Зарезервированное количество (decimal-строка)
   * @param now - updatedAt
   * @returns `Ok(record)` или `Err(ReservationTransitionError)` — запись не
   *   найдена, initial отрицательный, либо переход запрещён
   *
   * @remarks
   * Разрешённые переходы (см. doc порта):
   * - `NONE → HELD`;
   * - `SETTLED → HELD` только после увеличения `attempt` (новая попытка);
   * - `HELD → HELD` только идемпотентно с тем же `initial` (без потребления).
   *
   * Запрещено: `HELD` с другой суммой, `PARTIALLY_SETTLED`,
   * `RECONCILIATION_REQUIRED`, `SETTLED` в рамках той же попытки —
   * затирание unresolved journal возвращает `Err`.
   */
  public async markReservationHeld(
    clientOrderId: OrderId,
    initial: string,
    now: Date,
  ): Promise<Result<OrderSubmissionRecord, ReservationTransitionError>> {
    const key = String(clientOrderId);
    const existing = this._records.get(key);
    if (!existing) {
      return Err(new ReservationTransitionError(
        'INVARIANT_VIOLATION',
        `markReservationHeld: submission record not found for clientOrderId ${key}`,
      ));
    }
    const res = existing.reservation;
    // Идемпотентность: уже held на тот же initial и без активности — no-op.
    if (
      res.status === 'HELD' &&
      new Decimal(res.initial).equals(new Decimal(initial)) &&
      res.consumed === '0' &&
      res.released === '0'
    ) {
      return Ok(this._snapshot(existing));
    }
    // Запрещённые переходы: затирание unresolved journal.
    if (res.status === 'RECONCILIATION_REQUIRED' || res.status === 'PARTIALLY_SETTLED') {
      return Err(new ReservationTransitionError(
        'RECONCILIATION_LOCKED',
        `markReservationHeld: cannot overwrite unresolved reservation (status=${res.status}) for clientOrderId ${key}`,
      ));
    }
    if (res.status === 'HELD') {
      return Err(new ReservationTransitionError(
        'INVARIANT_VIOLATION',
        `markReservationHeld: reservation already HELD with different amounts (initial=${res.initial}, requested=${initial}) for clientOrderId ${key}`,
      ));
    }
    if (res.status === 'SETTLED') {
      // SETTLED → HELD допустим ТОЛЬКО для новой попытки (attempt увеличен в begin).
      const heldAt = this._heldAtAttempt.get(key);
      if (heldAt !== undefined && heldAt >= existing.attempt) {
        return Err(new ReservationTransitionError(
          'INVARIANT_VIOLATION',
          `markReservationHeld: SETTLED reservation can only be re-held after attempt increase (heldAtAttempt=${heldAt}, attempt=${existing.attempt}) for clientOrderId ${key}`,
        ));
      }
    }
    let held;
    try {
      held = heldReservation(res.kind, initial);
    } catch (err) {
      if (err instanceof ReservationTransitionError) return Err(err);
      throw err;
    }
    const updated = this._snapshot({ ...existing, reservation: held, updatedAt: now });
    this._records.set(key, updated);
    this._heldAtAttempt.set(key, existing.attempt);
    return Ok(updated);
  }

  /**
   * Фиксирует effectiveSize (venue скорректировал размер).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param effectiveSize - Фактический размер (decimal-строка)
   * @param now - updatedAt
   */
  public async setEffectiveSize(clientOrderId: OrderId, effectiveSize: string, now: Date): Promise<void> {
    this._transition(clientOrderId, { effectiveSize, updatedAt: now });
  }

  /**
   * Применяет reservation transition, идемпотентно по operationId.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param transition - `operationId`, `consume?`, `release?`, `status?`, `now`
   * @returns `Ok(record)` с новой резервацией или `Err(ReservationTransitionError)`
   */
  public async applyReservationTransition(
    clientOrderId: OrderId,
    transition: {
      readonly operationId: string;
      readonly consume?: string;
      readonly release?: string;
      readonly status?: ReservationStatus;
      readonly now: Date;
    },
  ): Promise<Result<OrderSubmissionRecord, ReservationTransitionError>> {
    const key = String(clientOrderId);
    const existing = this._records.get(key);
    if (!existing) {
      return Err(new ReservationTransitionError(
        'INVARIANT_VIOLATION',
        `applyReservationTransition: submission record not found for clientOrderId ${key}`,
      ));
    }

    // Идемпотентность: operationId уже применён — no-op, возвращаем текущую запись.
    const applied = this._appliedOps.get(key);
    if (applied?.has(transition.operationId)) {
      return Ok(this._snapshot(existing));
    }

    const deltaResult = applyReservationDelta(existing.reservation, {
      consume: transition.consume,
      release: transition.release,
      status: transition.status,
    });
    if (!deltaResult.ok) return deltaResult;

    const updated = this._snapshot({ ...existing, reservation: deltaResult.value, updatedAt: transition.now });
    this._records.set(key, updated);
    if (applied) {
      applied.add(transition.operationId);
    } else {
      this._appliedOps.set(key, new Set([transition.operationId]));
    }
    return Ok(updated);
  }

  /**
   * Помечает submission как VENUE_ACCEPTED (venue вернул venueOrderId, local save ещё нет).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param venueOrderId - venue orderId
   * @param now - updatedAt
   *
   * @remarks
   * Неизвестный clientOrderId — no-op (защита; begin должен был предшествовать).
   * Обновляет обратный индекс venueOrderId→clientOrderId.
   */
  public async markVenueAccepted(clientOrderId: OrderId, venueOrderId: OrderId, now: Date): Promise<void> {
    if (!this._records.has(String(clientOrderId))) return;
    this._indexVenue(venueOrderId, clientOrderId);
    this._transition(clientOrderId, { status: 'VENUE_ACCEPTED', venueOrderId, updatedAt: now });
  }

  /**
   * Помечает submission как COMMITTED.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param venueOrderId - venue orderId
   * @param now - updatedAt
   *
   * @remarks
   * Неизвестный clientOrderId — no-op. Обновляет обратный индекс. Резервацию НЕ
   * меняет — она остаётся held до fills / подтверждённой отмены.
   */
  public async markCommitted(clientOrderId: OrderId, venueOrderId: OrderId, now: Date): Promise<void> {
    if (!this._records.has(String(clientOrderId))) return;
    this._indexVenue(venueOrderId, clientOrderId);
    this._transition(clientOrderId, { status: 'COMMITTED', venueOrderId, updatedAt: now });
  }

  /**
   * Помечает submission как UNKNOWN (ambiguous).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param reason - Причина
   * @param venueOrderId - venue orderId, если известен
   * @param now - updatedAt
   */
  public async markUnknown(
    clientOrderId: OrderId,
    reason: string,
    venueOrderId: OrderId | undefined,
    now: Date,
  ): Promise<void> {
    if (!this._records.has(String(clientOrderId))) return;
    if (venueOrderId) this._indexVenue(venueOrderId, clientOrderId);
    this._transition(clientOrderId, { status: 'UNKNOWN', reason, venueOrderId, updatedAt: now });
  }

  /**
   * Помечает submission как FAILED (retry допустим).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param reason - Причина
   * @param now - updatedAt
   */
  public async markFailed(clientOrderId: OrderId, reason: string, now: Date): Promise<void> {
    this._transition(clientOrderId, { status: 'FAILED', reason, updatedAt: now });
  }

  /**
   * Возвращает запись по clientOrderId.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @returns Замороженный snapshot или undefined
   */
  public async get(clientOrderId: OrderId): Promise<OrderSubmissionRecord | undefined> {
    const record = this._records.get(String(clientOrderId));
    return record ? this._snapshot(record) : undefined;
  }

  /**
   * Обратный поиск записи по venueOrderId.
   *
   * @param venueOrderId - venue orderId
   * @returns Замороженный snapshot или undefined
   */
  public async findByVenueOrderId(venueOrderId: OrderId): Promise<OrderSubmissionRecord | undefined> {
    const clientOrderId = this._byVenue.get(String(venueOrderId));
    if (clientOrderId === undefined) return undefined;
    const record = this._records.get(clientOrderId);
    return record ? this._snapshot(record) : undefined;
  }

  /**
   * Применяет частичное обновление к существующей записи (no-op если нет).
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param patch - Частичное обновление
   */
  private _transition(
    clientOrderId: OrderId,
    patch: Partial<OrderSubmissionRecord>,
  ): void {
    const key = String(clientOrderId);
    const existing = this._records.get(key);
    if (!existing) return;
    this._records.set(key, this._snapshot({ ...existing, ...patch }));
  }

  /** Очищает хранилище и все индексы (для тестов). */
  public clear(): void {
    this._records.clear();
    this._byVenue.clear();
    this._appliedOps.clear();
    this._heldAtAttempt.clear();
  }
}
