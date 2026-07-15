/**
 * Порт: submission guard по clientOrderId — защита от небезопасного повторного submit.
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
 * процессе; (c) ambiguous/unknown submission → не retry-ить автоматически.
 *
 * ### Что это НЕ:
 * Это operational guard, а НЕ trading state и НЕ replacement для Order-репозитория.
 * Он не хранит доменный Order — только lifecycle факта «мы отправляли ордер под
 * этим clientOrderId и что из этого вышло».
 *
 * ### Идемпотентность/atomicity:
 * `begin()` атомарно резервирует clientOrderId под submission (аналог
 * `IProcessedFillRepository.begin`). Реализация обязана вызываться ВНУТРИ того
 * же keyed mutex, что и PlaceOrderUseCase, чтобы `begin → submit → markCommitted`
 * не пересекались для одного clientOrderId.
 *
 * @example
 * ```typescript
 * const begin = await submissions.begin({ clientOrderId, accountId, instrumentId, now });
 * if (begin.outcome === 'ALREADY_COMMITTED') return Ok(begin.record.venueOrderId!);
 * // ... submit ... on success:
 * await submissions.markCommitted(clientOrderId, venueOrderId, now);
 * ```
 */
import type { AccountId, InstrumentId, OrderId } from '@polymarket/ids';

/**
 * Статус submission по clientOrderId.
 *
 * @remarks
 * - `SUBMITTING` — `begin()` зарезервировал, submit в процессе (не завершён).
 * - `COMMITTED` — Order успешно сохранён локально (есть `venueOrderId`).
 * - `UNKNOWN` — ambiguous исход (MAY_HAVE_BEEN_SUBMITTED / UNKNOWN submit):
 *   venue-ордер мог быть создан, автоматический retry НЕ разрешён.
 * - `FAILED` — submit точно не создал ордер (DEFINITELY_NOT_SUBMITTED / REJECTED):
 *   retry допустим (см. `BeginOrderSubmissionResult.FAILED_RETRYABLE`).
 */
export type OrderSubmissionStatus =
  | 'SUBMITTING'
  | 'COMMITTED'
  | 'UNKNOWN'
  | 'FAILED';

/** Запись о submission по clientOrderId. */
export interface OrderSubmissionRecord {
  readonly clientOrderId: OrderId;
  readonly venueOrderId?: OrderId;
  readonly status: OrderSubmissionStatus;
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
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
 * - `IN_PROGRESS` — submission уже идёт (`SUBMITTING`): ка_ller возвращает Err
 *   («submission in progress»), не запускает второй submit.
 * - `UNKNOWN` — прошлый submit был ambiguous: caller возвращает Err и НЕ
 *   retry-ит автоматически (нужна ручная реконсиляция).
 * - `FAILED_RETRYABLE` — прошлый submit точно не создал ордер: caller продолжает
 *   (begin переводит запись в `SUBMITTING`).
 */
export type BeginOrderSubmissionResult =
  | { readonly outcome: 'ACQUIRED' }
  | { readonly outcome: 'ALREADY_COMMITTED'; readonly record: OrderSubmissionRecord }
  | { readonly outcome: 'IN_PROGRESS'; readonly record: OrderSubmissionRecord }
  | { readonly outcome: 'UNKNOWN'; readonly record: OrderSubmissionRecord }
  | { readonly outcome: 'FAILED_RETRYABLE'; readonly record: OrderSubmissionRecord };

/** Репозиторий submission guard. */
export interface IOrderSubmissionRepository {
  /**
   * Атомарно резервирует clientOrderId под submission.
   *
   * @param input - `clientOrderId`, `accountId`, `instrumentId`, `now`
   * @returns `BeginOrderSubmissionResult` (см. типы)
   */
  begin(input: {
    readonly clientOrderId: OrderId;
    readonly accountId: AccountId;
    readonly instrumentId: InstrumentId;
    readonly now: Date;
  }): Promise<BeginOrderSubmissionResult>;

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
   * Возвращает текущую запись submission по clientOrderId.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @returns Запись или `undefined`, если clientOrderId неизвестен
   */
  get(clientOrderId: OrderId): Promise<OrderSubmissionRecord | undefined>;
}
