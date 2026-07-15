/**
 * InMemoryOrderSubmissionRepository — submission guard по clientOrderId в памяти.
 *
 * @remarks
 * Реализует `IOrderSubmissionRepository` на основе `Map<clientOrderId, record>`.
 * Используется PlaceOrderUseCase (под keyed mutex) для защиты от небезопасного
 * повторного submit с тем же clientOrderId.
 *
 * ### Семантика begin():
 * - Записи нет → `SUBMITTING`, `{ outcome: 'ACQUIRED' }`.
 * - `COMMITTED` → `{ outcome: 'ALREADY_COMMITTED', record }` (не трогаем).
 * - `SUBMITTING` → `{ outcome: 'IN_PROGRESS', record }` (не трогаем).
 * - `UNKNOWN` → `{ outcome: 'UNKNOWN', record }` (не трогаем — не retry-им авто).
 * - `FAILED` → `SUBMITTING`, `{ outcome: 'FAILED_RETRYABLE', record: <prev> }`.
 *
 * ### Отличие от production:
 * Production использует Redis/PostgreSQL (unique constraint + status) для
 * multi-process и персистентности. In-memory — single-process/paper/backtest/тесты.
 *
 * @example
 * ```typescript
 * const repo = new InMemoryOrderSubmissionRepository();
 * const begin = await repo.begin({ clientOrderId, accountId, instrumentId, now });
 * if (begin.outcome === 'ACQUIRED') {
 *   // submit ... on success:
 *   await repo.markCommitted(clientOrderId, venueOrderId, now);
 * }
 * ```
 */
import type { AccountId, InstrumentId, OrderId } from '@polymarket/ids';
import type {
  IOrderSubmissionRepository,
  OrderSubmissionRecord,
  BeginOrderSubmissionResult,
} from '@polymarket/ports';

/**
 * In-memory реализация submission guard.
 *
 * @remarks
 * Хранит запись по строковому ключу clientOrderId. Возвращает замороженные
 * snapshot-копии (наружу не отдаётся мутабельная ссылка). Не персистентна.
 */
export class InMemoryOrderSubmissionRepository implements IOrderSubmissionRepository {
  private readonly _records = new Map<string, OrderSubmissionRecord>();

  /**
   * @param record - Исходная запись
   * @returns Замороженная snapshot-копия с клонированными Date
   */
  private _snapshot(record: OrderSubmissionRecord): OrderSubmissionRecord {
    return Object.freeze({
      ...record,
      createdAt: new Date(record.createdAt.getTime()),
      updatedAt: new Date(record.updatedAt.getTime()),
    });
  }

  /**
   * Атомарно резервирует clientOrderId под submission.
   *
   * @param input - `clientOrderId`, `accountId`, `instrumentId`, `now`
   * @returns `BeginOrderSubmissionResult` (см. doc порта)
   */
  public async begin(input: {
    readonly clientOrderId: OrderId;
    readonly accountId: AccountId;
    readonly instrumentId: InstrumentId;
    readonly now: Date;
  }): Promise<BeginOrderSubmissionResult> {
    const key = String(input.clientOrderId);
    const existing = this._records.get(key);

    if (existing) {
      if (existing.status === 'COMMITTED') {
        return { outcome: 'ALREADY_COMMITTED', record: this._snapshot(existing) };
      }
      if (existing.status === 'SUBMITTING') {
        return { outcome: 'IN_PROGRESS', record: this._snapshot(existing) };
      }
      if (existing.status === 'UNKNOWN') {
        return { outcome: 'UNKNOWN', record: this._snapshot(existing) };
      }
      // FAILED → разрешаем retry: переводим в SUBMITTING, возвращаем прежнюю запись.
      const prev = this._snapshot(existing);
      this._records.set(key, this._snapshot({
        ...existing,
        status: 'SUBMITTING',
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
      createdAt: input.now,
      updatedAt: input.now,
    }));
    return { outcome: 'ACQUIRED' };
  }

  /**
   * Помечает submission как COMMITTED.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param venueOrderId - venue orderId
   * @param now - updatedAt
   *
   * @remarks
   * Неизвестный clientOrderId — no-op (защита; begin должен был предшествовать).
   */
  public async markCommitted(clientOrderId: OrderId, venueOrderId: OrderId, now: Date): Promise<void> {
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

  /** Очищает хранилище (для тестов). */
  public clear(): void {
    this._records.clear();
  }
}
