/**
 * UpdateOrderStatusUseCase — применяет venue-обновление статуса к Order entity.
 *
 * @remarks
 * Содержит всю доменную логику, ранее находившуюся в `OrderUpdateHandler`.
 * Тонкий `OrderUpdateHandler` теперь только парсит WS и публикует
 * `ORDER_UPDATE_RECEIVED`; `OrderUpdateOrchestrator` вызывает этот use case.
 *
 * ### Алгоритм:
 * 0. Взять keyed mutex по [accountId, orderId] — сериализует с PlaceOrderUseCase
 *    (пересечение по accountId), закрывая race «ранний terminal ORDER_UPDATE до
 *    локального save». Если Order всё ещё не найден под lock и update терминален
 *    (CANCELLED/REJECTED/EXPIRED) — создаётся `VENUE_LOCAL_ORDER_DESYNC` issue
 *    (`EARLY_ORDER_UPDATE_WITHOUT_LOCAL_ORDER`), возвращается Ok (без retry-loop).
 * 1. Атомарно прочитать Order + версию (getWithVersion) из репозитория
 * 2. Применить доменный метод (accept/reject/cancel/expire)
 * 3. Обработать idempotent/race сценарии
 * 4. CAS-сохранение обновлённого Order (save(order, expectedVersion))
 * 5. Для CANCELLED/EXPIRED/REJECTED — освободить резервацию Portfolio (только
 *    после успешного CAS save). Сбой release → error-лог +
 *    `ORDER_PORTFOLIO_DESYNC` reconciliation issue (best-effort), результат
 *    остаётся Ok — update уже committed
 * 6. Опубликовать OrderEvent[] в EventBus — notification path, НЕ часть
 *    транзакции: сбой publish после успешного CAS save логируется как
 *    `EVENT_PUBLISH_FAILED` и НЕ меняет результат (Ok) — committed update
 *    не должен становиться retryable из-за потери уведомления
 *
 * ### Защита от concurrent fill (CAS):
 * Между чтением версии и save мог выполниться ProcessFillUseCase и перезаписать
 * Order статус (FILLED) через saveSync — тогда версия выросла и CAS save вернёт
 * VersionConflictError. При конфликте перечитываем актуальное состояние:
 * если ордер терминален / уже в целевом статусе / исчез — идемпотентный no-op
 * (Ok, БЕЗ release/publish); иначе Err. Резервация освобождается только после
 * успешного CAS save — значит fill её потребить не успел.
 *
 * @example
 * ```typescript
 * const useCase = new UpdateOrderStatusUseCase({
 *   orderRepo, orderStateStore, portfolioService, eventBus, logger,
 * });
 * const result = await useCase.execute({
 *   update: { type: 'CANCELLED', orderId },
 *   accountId,
 * });
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import { assetIdToInstrumentId } from '@polymarket/ids';
import type { AccountId, OrderId } from '@polymarket/ids';
import { lockKey } from './lockKeys.js';
import type {
  IOrderRepository,
  IOrderStateStore,
  IKeyedMutex,
  IReconciliationIssueRepository,
  ReconciliationIssue,
  IOrderedEventOutbox,
  IOrderSubmissionRepository,
} from '@polymarket/ports';
import { pendingMatchFillId, canConsumeHeldReservation, hasHeldReservation } from '@polymarket/ports';
import type { OrderSubmissionRecord } from '@polymarket/ports';
import type { InstrumentId } from '@polymarket/ids';
import { accountIdToString } from '@polymarket/ids';
import type { ApplicationEvent, VenueOrderUpdate } from '@polymarket/application-events';
import type { PortfolioService } from './services/PortfolioService.js';
import { enqueueCommittedEvents } from './services/enqueueCommittedEvents.js';

/** Входные данные для UpdateOrderStatusUseCase */
export interface UpdateOrderStatusInput {
  /** Venue-обновление статуса с типом и orderId */
  readonly update: VenueOrderUpdate;
  /** ID аккаунта — нужен для операций с Portfolio */
  readonly accountId: AccountId;
}

/** Зависимости UpdateOrderStatusUseCase */
export interface UpdateOrderStatusDeps {
  readonly orderRepo: IOrderRepository;
  readonly orderStateStore: IOrderStateStore;
  readonly portfolioService: PortfolioService;
  /**
   * Keyed mutex — сериализует обработку update относительно PlaceOrderUseCase
   * (и ProcessFillUseCase/CancelOrderUseCase) по [accountId, orderId].
   *
   * @remarks
   * Закрывает race «ранний ORDER_UPDATE до локального save»: venue мог прислать
   * CANCELLED/REJECTED/EXPIRED раньше, чем PlaceOrderUseCase успел сохранить
   * Order после submitOrder(). Все use-case'ы держат `accountId` в lock-ключах,
   * поэтому update ждёт завершения конкурентного Place для того же аккаунта и
   * видит уже сохранённый Order вместо тихого сброса.
   */
  readonly keyedMutex: IKeyedMutex;
  /**
   * Ordered event outbox — order-события enqueue-ятся под lock (aggregateId=orderId),
   * flush ПОСЛЕ выхода из lock. Заменяет прямой `eventBus.publishAll` под mutex
   * (исключает deadlock: handler ORDER_CANCELLED → lock-зависимый use-case).
   */
  readonly orderedEventOutbox: IOrderedEventOutbox;
  /**
   * Submission guard + reservation journal — при терминальном venue-update
   * (CANCELLED/EXPIRED/REJECTED) освобождает остаток резервации в журнале
   * (release → SETTLED), best-effort.
   */
  readonly submissions: IOrderSubmissionRepository;
  readonly logger: ILogger;
  /**
   * Queryable хранилище reconciliation issues (опционально).
   *
   * @remarks
   * Optional — чтобы не ломать существующие конструкторы/тесты: без него
   * поведение прежнее (только logging). Если передан, сбой release резервации
   * ПОСЛЕ успешного CAS save (ордер уже terminal, резервация может остаться
   * замороженной) создаёт `ORDER_PORTFOLIO_DESYNC` issue. Сбой `add()`
   * логируется и НЕ меняет результат use case.
   */
  readonly reconciliationIssues?: IReconciliationIssueRepository;
  /**
   * Источник времени для `ReconciliationIssue.createdAt` (опционально).
   *
   * @remarks
   * Optional по той же причине. Без него используется `new Date()`.
   */
  readonly clock?: IClock;
}

/**
 * Use case применения venue-обновления статуса ордера.
 *
 * @remarks
 * Вызывается `OrderUpdateOrchestrator` при подписке на `ORDER_UPDATE_RECEIVED`
 * или напрямую из reconciler для синхронной обработки.
 */
export class UpdateOrderStatusUseCase {
  private readonly _logger: ILogger;

  /**
   * @param _deps - Зависимости use case
   */
  constructor(private readonly _deps: UpdateOrderStatusDeps) {
    this._logger = _deps.logger.child({ component: 'UpdateOrderStatusUseCase' });
  }

  /**
   * Best-effort создание reconciliation issue (release failure после CAS save).
   *
   * @param issue - Issue с детерминированным id (см. call site)
   *
   * @remarks
   * No-op, если `reconciliationIssues` не передан в deps. `add()` идемпотентен
   * по id. Ошибка `add()` логируется и проглатывается — issue не должен менять
   * результат use case (update уже committed → Ok).
   */
  private async _addReconciliationIssue(issue: ReconciliationIssue): Promise<void> {
    if (!this._deps.reconciliationIssues) {
      return;
    }
    try {
      await this._deps.reconciliationIssues.add(issue);
    } catch (err) {
      this._logger.error('Failed to add reconciliation issue', {
        issueId: issue.id,
        issueType: issue.type,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Применяет venue-обновление статуса к существующему ордеру.
   *
   * @param input - Входные данные с update и accountId
   * @returns Ok(void) при успехе или идемпотентном skip, Err при критических сбоях
   *
   * @remarks
   * Idempotent: дублирующие события (ACCEPTED на OPEN, CANCELLED на CANCELED) —
   * логируются на уровне debug/warn и возвращают Ok(void).
   */
  public async execute(input: UpdateOrderStatusInput): Promise<Result<void, TradingError>> {
    const { accountId } = input;
    const orderId: OrderId = input.update.orderId;

    // Keyed mutex по [account, order] — сериализует относительно PlaceOrderUseCase
    // (держит [account, instrument]; пересечение по account) и ProcessFill/Cancel
    // (держат account+order). Namespaced keys (lockKey.*) — см. lockKeys.ts.
    // Закрывает race «ранний terminal ORDER_UPDATE до локального save Order».
    const lockKeys = [lockKey.account(accountId), lockKey.order(orderId)];
    const result = await this._deps.keyedMutex.runExclusive(lockKeys, () => this._executeLocked(input));
    // flush() ВНЕ lock: публикует enqueued order-события (никогда не бросает).
    await this._deps.orderedEventOutbox.flush();
    return result;
  }

  /**
   * Освобождает остаток резервации в execution journal при терминальном update.
   *
   * @param venueOrderId - venue orderId (для обратного поиска записи)
   * @returns `{ ok: true }` при успехе (в т.ч. записи/остатка нет);
   *   `{ ok: false, error }` при сбое transition — caller ОБЯЗАН сохранить
   *   reconciliation block/issue
   *
   * @remarks
   * COMMIT-CRITICAL (Этап 6.2): вызывается ТОЛЬКО после успешного Portfolio
   * release. operationId attempt-scoped (`attempt:${attempt}:venue-update-release`).
   */
  private async _releaseJournalReservation(
    venueOrderId: OrderId,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    try {
      const record = await this._deps.submissions.findByVenueOrderId(venueOrderId);
      if (!record) return { ok: true };
      const remaining = new Decimal(record.reservation.remaining);
      if (remaining.lessThanOrEqualTo(0)) return { ok: true };
      const r = await this._deps.submissions.applyReservationTransition(record.clientOrderId, {
        operationId: `attempt:${record.attempt}:venue-update-release`,
        release: remaining.toString(),
        now: this._deps.clock?.now() ?? new Date(),
      });
      if (!r.ok) {
        this._logger.error('Reservation journal release failed on terminal venue update', {
          venueOrderId: String(venueOrderId),
          error: r.error.message,
        });
        return { ok: false, error: r.error.message };
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('Reservation journal release threw on terminal venue update', {
        venueOrderId: String(venueOrderId),
        err: err instanceof Error ? err : new Error(message),
      });
      return { ok: false, error: message };
    }
  }

  /**
   * Помечает резервацию в журнале RECONCILIATION_REQUIRED — best-effort.
   *
   * @param venueOrderId - venue orderId (обратный поиск записи)
   * @param operationSuffix - Суффикс attempt-scoped operationId
   *
   * @remarks
   * Используется при сбое Portfolio release: journal НЕЛЬЗЯ переводить в
   * SETTLED (капитал может остаться замороженным).
   */
  private async _markJournalReconciliationRequired(venueOrderId: OrderId, operationSuffix: string): Promise<void> {
    try {
      const record = await this._deps.submissions.findByVenueOrderId(venueOrderId);
      if (!record) return;
      const r = await this._deps.submissions.applyReservationTransition(record.clientOrderId, {
        operationId: `attempt:${record.attempt}:${operationSuffix}`,
        status: 'RECONCILIATION_REQUIRED',
        now: this._deps.clock?.now() ?? new Date(),
      });
      if (!r.ok) {
        this._logger.error('Failed to mark reservation journal RECONCILIATION_REQUIRED on venue update', {
          venueOrderId: String(venueOrderId),
          error: r.error.message,
        });
      }
    } catch (err) {
      this._logger.error('Failed to mark reservation journal RECONCILIATION_REQUIRED on venue update (threw)', {
        venueOrderId: String(venueOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Снимает pending cancel marker (uncertain-cancel placeholder) после
   * authoritative terminal update (Этап 6.3).
   *
   * @param orderId - venue orderId
   *
   * @remarks
   * Вызывается ТОЛЬКО после успешного settlement (Portfolio + journal) либо
   * когда reconciliation-блок уже явно установлен другим механизмом. Без этого
   * placeholder от неопределённого cancel держал бы `hasUnsettledFills=true`
   * вечно, даже когда venue авторитетно подтвердил terminal-статус.
   */
  private _clearPendingCancelMarker(orderId: OrderId): void {
    const placeholder = pendingMatchFillId(orderId);
    this._deps.orderStateStore.clearOrderFillMatched(orderId, placeholder);
    this._deps.orderStateStore.clearInFlightFill(placeholder);
  }

  /**
   * Ставит typed manual reconciliation block при частичном commit terminal update.
   *
   * @param orderId - venue orderId
   * @param instrumentId - InstrumentId (если резолвится)
   * @param reason - Причина блока (English, для оператора)
   *
   * @remarks
   * Используется ИМЕННО manual block (не MATCHED placeholder): placeholder
   * снимается первым реальным fill-ом, а этот блок обязан пережить fill
   * (guard в ProcessFillUseCase блокирует fill и НЕ снимает блок). Снятие —
   * только явное, после ручной реконсиляции.
   */
  private _markReconciliationBlock(orderId: OrderId, instrumentId: InstrumentId | undefined, reason: string): void {
    if (!instrumentId) return;
    this._deps.orderStateStore.markManualReconciliationBlock({
      orderId,
      instrumentId,
      reason,
    });
  }

  /**
   * Terminal update БЕЗ локального Order, но С execution record (Этап 6.1):
   * освобождает held-резервацию по журналу.
   *
   * @param input - Входные данные (update, accountId)
   * @param execution - Найденная запись execution journal (по venueOrderId)
   * @returns Ok(void) — update поглощён (авто-retry не нужен)
   *
   * @remarks
   * Алгоритм:
   * 1. Проверка account: чужая запись → issue, ничего не трогаем.
   * 2. Reservation RECONCILIATION_REQUIRED → не трогаем (существующий issue),
   *    блокирующий marker сохраняется.
   * 3. Held-резервация → Portfolio release по `reservation.kind` и
   *    `reservation.remaining`; journal release ТОЛЬКО после успешного
   *    Portfolio release. Частичный commit → issue + blocking marker.
   * 4. Успешный settlement (или изначально нечего освобождать) → снимаем
   *    pending cancel marker (Этап 6.3). Фиктивный Order НЕ создаётся.
   */
  private async _releaseHeldExecutionOnTerminalUpdate(
    input: UpdateOrderStatusInput,
    execution: OrderSubmissionRecord,
  ): Promise<Result<void, TradingError>> {
    const { update, accountId } = input;
    const orderId: OrderId = update.orderId;
    const accountKey = (id: typeof accountId): string =>
      typeof id === 'string' ? id : accountIdToString(id);

    // Шаг 1: запись должна принадлежать тому же аккаунту.
    if (accountKey(execution.accountId) !== accountKey(accountId)) {
      this._logger.error('Terminal venue update matched execution record of DIFFERENT account — not releasing', {
        orderId: String(orderId),
        updateType: update.type,
        executionAccountId: accountKey(execution.accountId),
        updateAccountId: accountKey(accountId),
      });
      await this._addReconciliationIssue({
        id: `reconciliation:order-update:${String(orderId)}:execution-account-mismatch`,
        type: 'VENUE_LOCAL_ORDER_DESYNC',
        status: 'OPEN',
        reason: 'TERMINAL_UPDATE_EXECUTION_ACCOUNT_MISMATCH',
        createdAt: this._deps.clock?.now() ?? new Date(),
        orderId,
        accountId,
        context: {
          stage: 'terminal-update-held-execution-release',
          updateType: update.type,
          executionAccountId: accountKey(execution.accountId),
        },
      });
      return Ok(undefined);
    }

    // Шаг 2: RECONCILIATION_REQUIRED — авто-освобождение запрещено.
    if (execution.reservation.status === 'RECONCILIATION_REQUIRED') {
      this._logger.error('Terminal venue update for execution with RECONCILIATION_REQUIRED reservation — manual reconciliation required', {
        orderId: String(orderId),
        updateType: update.type,
        clientOrderId: String(execution.clientOrderId),
      });
      this._markReconciliationBlock(orderId, execution.instrumentId, 'TERMINAL_UPDATE_RESERVATION_RECONCILIATION_REQUIRED');
      return Ok(undefined);
    }

    // Шаг 3: held-резервация → НЕ освобождаем автоматически (Шаг 5, delayed-fill
    // race): ставим TerminalSettlementPending — release только authoritative
    // остатка выполнит SettleTerminalOrdersUseCase после применения venue trades.
    if (canConsumeHeldReservation(execution.reservation)) {
      this._deps.orderStateStore.markTerminalSettlementPending({
        accountId,
        orderId,
        instrumentId: execution.instrumentId,
        venueStatus: update.type as 'CANCELLED' | 'EXPIRED' | 'REJECTED',
        receivedAt: this._deps.clock?.now() ?? new Date(),
      });
      this._logger.info('Terminal venue update for held execution (no local Order) — settlement deferred until delayed-fill window resolves', {
        orderId: String(orderId),
        updateType: update.type,
        clientOrderId: String(execution.clientOrderId),
        reservationRemaining: execution.reservation.remaining,
      });
      // Pending cancel marker НЕ снимаем — снимет settle-резолвер.
      return Ok(undefined);
    }

    // Шаг 4: нечего освобождать (резервация уже settled) → снимаем pending
    // cancel marker, чтобы hasUnsettledFills не остался true навсегда.
    this._clearPendingCancelMarker(orderId);
    return Ok(undefined);
  }

  /**
   * Тело обработки update — вызывается ВНУТРИ keyed mutex.
   *
   * @param input - Входные данные с update и accountId
   * @returns Ok(void) при успехе/идемпотентном skip, Err при критических сбоях
   */
  private async _executeLocked(input: UpdateOrderStatusInput): Promise<Result<void, TradingError>> {
    const { update, accountId } = input;
    const orderId: OrderId = update.orderId;

    // Шаг 1: Получить Order + версию атомарно.
    // getWithVersion() гарантирует, что version относится к ТОЙ ЖЕ записи,
    // что и order — раздельные get()+getVersion() содержали yield-окно между
    // двумя await, где конкурирующая мутация могла бы рассинхронизировать
    // пару (не потеря данных — CAS save ниже всё равно поймал бы конфликт —
    // но лишний ложный конфликт под нагрузкой).
    const snapshot = await this._deps.orderRepo.getWithVersion(orderId);
    const order = snapshot?.order;
    const expectedVersion = snapshot?.version ?? 0;
    if (!order) {
      // Order по-прежнему не найден ДАЖЕ после ожидания lock. Для terminal
      // update-типов (CANCELLED/REJECTED/EXPIRED) сначала пробуем recovery через
      // execution journal (Этап 6.1): ambiguous submit мог заморозить капитал
      // без локального Order — авторитетный terminal-статус venue позволяет
      // безопасно освободить held-резервацию (Portfolio → journal). Фиктивный
      // Order НЕ создаётся.
      const isTerminalUpdate =
        update.type === 'CANCELLED' || update.type === 'REJECTED' || update.type === 'EXPIRED';
      if (isTerminalUpdate) {
        const execution = await this._deps.submissions.findByVenueOrderId(orderId);
        if (execution) {
          return this._releaseHeldExecutionOnTerminalUpdate(input, execution);
        }
      }
      // Execution record отсутствует (или update не terminal) — существующий
      // desync issue: venue сообщил о состоянии ордера, которого локально нет.
      // Тихий drop потерял бы факт события. Возвращаем Ok (handler не должен
      // retry-loop-ить без локального order).
      this._logger.error('VENUE_ORDER_UPDATE_WITHOUT_LOCAL_ORDER: venue update for order missing locally (even under lock)', {
        orderId: String(orderId),
        updateType: update.type,
        terminal: isTerminalUpdate,
      });
      await this._addReconciliationIssue({
        id: `reconciliation:order-update:${String(orderId)}:update-without-local-order:${update.type}`,
        type: 'VENUE_LOCAL_ORDER_DESYNC',
        status: 'OPEN',
        reason: `VENUE_ORDER_UPDATE_WITHOUT_LOCAL_ORDER:${update.type}`,
        createdAt: this._deps.clock?.now() ?? new Date(),
        orderId,
        accountId,
        context: {
          stage: 'venue-update-order-not-found-under-lock',
          updateType: update.type,
          // ACCEPTED — обычно benign race (Place ещё публикует ACCEPTED сам),
          // но всё равно фиксируем; terminal — более серьёзно.
          terminal: isTerminalUpdate,
        },
      });
      return Ok(undefined);
    }

    // Шаг 2: Применить доменный метод
    let result;
    switch (update.type) {
      case 'ACCEPTED':
        result = order.accept();
        break;
      case 'REJECTED':
        result = order.reject(update.reason);
        break;
      case 'CANCELLED':
        result = order.cancel(update.reason);
        break;
      case 'EXPIRED':
        result = order.expire();
        break;
    }

    // Шаг 3: Обработать idempotent/race сценарии
    if (!result.ok) {
      const isIdempotent =
        (update.type === 'ACCEPTED'  && order.status === 'OPEN')    ||
        (update.type === 'CANCELLED' && order.status === 'CANCELED') ||
        (update.type === 'EXPIRED'   && order.status === 'EXPIRED');

      // ACCEPTED на терминальном ордере — гонка между REST-cancel и WS-confirmation.
      const isCancelRace = update.type === 'ACCEPTED' && order.isTerminal;

      if (isIdempotent) {
        this._logger.debug('Ignoring duplicate venue update (already in target state)', {
          orderId: String(orderId),
          updateType: update.type,
          currentStatus: order.status,
        });
        return Ok(undefined);
      } else if (isCancelRace) {
        this._logger.warn('ACCEPTED event arrived after order already terminal (cancel/fill race) — ignoring', {
          orderId: String(orderId),
          currentStatus: order.status,
          updateType: update.type,
        });
        return Ok(undefined);
      } else {
        this._logger.error('Failed to apply order update', {
          error: result.error.message,
          orderId: String(orderId),
          updateType: update.type,
        });
        return Err(new TradingError(
          `Failed to apply order update: ${result.error.message}`,
          { context: { orderId: String(orderId), updateType: update.type } },
        ));
      }
    }

    const updatedOrder = result.value;

    // Шаг 4: CAS-сохранение обновлённого Order.
    // Конфликт версии = конкурирующая мутация (например, fill через saveSync)
    // успела между чтением версии и записью — резервацию НЕ трогаем и события
    // НЕ публикуем, вместо этого перечитываем актуальное состояние.
    const events = updatedOrder.pullEvents();
    const saveResult = await this._deps.orderRepo.save(updatedOrder, expectedVersion);
    if (!saveResult.ok) {
      const latest = await this._deps.orderRepo.get(orderId);
      if (!latest || latest.status === updatedOrder.status || latest.isTerminal) {
        // Ордер исчез (cleanup), уже в целевом статусе (дубль-событие) или
        // терминален (конкурирующий fill/cancel обработал его первым) —
        // идемпотентный no-op; резервация обработана той мутацией.
        this._logger.warn('Order version conflict during venue update — latest state already settled, no-op', {
          orderId: String(orderId),
          updateType: update.type,
          latestStatus: latest?.status,
        });
        return Ok(undefined);
      }
      this._logger.error('Order version conflict during venue update', {
        orderId: String(orderId),
        updateType: update.type,
        expected: saveResult.error.expected,
        actual: saveResult.error.actual,
        latestStatus: latest.status,
      });
      return Err(new TradingError(
        `Order version conflict during venue update: ${saveResult.error.message}`,
        { context: { orderId: String(orderId), updateType: update.type, latestStatus: latest.status } },
      ));
    }

    // Шаг 5: Для venue-initiated терминальных статусов — освободить резервацию
    // Portfolio. REJECTED включён наравне с CANCELLED/EXPIRED: venue отклонил
    // уже сохранённый локальный ордер — live-ордера нет, резервация без release
    // осталась бы замороженной навсегда.
    // ТОЛЬКО после успешного CAS save: успех гарантирует, что между чтением
    // версии и записью не было конкурирующего fill (saveSync инкрементит
    // версию → был бы конфликт), т.е. резервация ещё не потреблена.
    //
    // Сбой release после committed save — Order↔Portfolio desync (замороженная
    // резервация): НЕ retryable business Err (update уже committed), логируем +
    // best-effort reconciliation issue и продолжаем к публикации/Ok.
    if (update.type === 'CANCELLED' || update.type === 'EXPIRED' || update.type === 'REJECTED') {
      const instrumentId = assetIdToInstrumentId(updatedOrder.asset);

      // Delayed-fill race guard (Шаг 5): partial fill мог произойти на venue,
      // а terminal update пришёл ПЕРВЫМ. Немедленный release остатка завысил
      // бы available (незаработанный капитал), а поздний fill дебетовал бы
      // available второй раз. При held journal-резервации капитал НЕ
      // освобождаем: ставим TerminalSettlementPending (блокирует Place/Cancel/
      // strategy через hasUnsettledFills, но НЕ ProcessFillUseCase — delayed
      // fill применится held-path). Release только authoritative остатка и
      // снятие pending выполняет SettleTerminalOrdersUseCase после применения
      // всех venue trades.
      const execution = await this._deps.submissions.findByVenueOrderId(orderId);
      if (execution && hasHeldReservation(execution.reservation)) {
        this._deps.orderStateStore.markTerminalSettlementPending({
          accountId,
          orderId,
          instrumentId: execution.instrumentId,
          venueStatus: update.type,
          receivedAt: this._deps.clock?.now() ?? new Date(),
        });
        this._logger.info('Terminal venue update with held reservation — settlement deferred until delayed-fill window resolves', {
          orderId: String(orderId),
          updateType: update.type,
          reservationRemaining: execution.reservation.remaining,
        });
        // Pending cancel marker НЕ снимаем — снимет settle-резолвер.
        await this._enqueueAndFinish(orderId, accountId, update.type, events);
        return Ok(undefined);
      }

      // Legacy-путь (нет journal-резервации): прежнее немедленное освобождение.
      const releaseResult = this._deps.portfolioService.releaseOrderReservation(accountId, updatedOrder);
      if (!releaseResult.ok) {
        // Portfolio release упал → journal НЕ settle (Этап 6.2): помечаем
        // RECONCILIATION_REQUIRED, сохраняем reconciliation block, pending
        // marker НЕ снимаем.
        this._logger.error('VENUE_UPDATE_RESERVATION_RELEASE_FAILED: reservation release failed after committed venue update — reservation may stay frozen', {
          orderId: String(orderId),
          updateType: update.type,
          error: releaseResult.error.message,
        });
        await this._markJournalReconciliationRequired(orderId, 'venue-update-release-failed');
        this._markReconciliationBlock(orderId, instrumentId, `VENUE_UPDATE_RESERVATION_RELEASE_FAILED: ${releaseResult.error.message}`);
        await this._addReconciliationIssue({
          id: `reconciliation:order-update:${String(orderId)}:reservation-release-failed`,
          type: 'ORDER_PORTFOLIO_DESYNC',
          status: 'OPEN',
          reason: `VENUE_UPDATE_RESERVATION_RELEASE_FAILED: ${releaseResult.error.message}`,
          createdAt: this._deps.clock?.now() ?? new Date(),
          orderId,
          accountId,
          ...(instrumentId ? { instrumentId } : {}),
          context: {
            stage: 'venue-update-release-reservation-after-order-save',
            updateType: update.type,
          },
        });
      } else {
        // Journal release ТОЛЬКО после успешного Portfolio release (Этап 6.2);
        // Result обязательно проверяется.
        const journalRelease = await this._releaseJournalReservation(orderId);
        if (!journalRelease.ok) {
          // Journal остался НЕ settled при уже освобождённом Portfolio (самый
          // опасный desync) → best-effort RECONCILIATION_REQUIRED + manual block.
          await this._markJournalReconciliationRequired(orderId, 'venue-update-journal-release-failed');
          this._markReconciliationBlock(orderId, instrumentId, `VENUE_UPDATE_JOURNAL_RELEASE_FAILED: ${journalRelease.error}`);
          await this._addReconciliationIssue({
            id: `reconciliation:order-update:${String(orderId)}:journal-release-failed`,
            type: 'RESERVATION_JOURNAL_DESYNC',
            status: 'OPEN',
            reason: `VENUE_UPDATE_JOURNAL_RELEASE_FAILED: ${journalRelease.error}`,
            createdAt: this._deps.clock?.now() ?? new Date(),
            orderId,
            accountId,
            ...(instrumentId ? { instrumentId } : {}),
            context: { stage: 'venue-update-journal-release-after-portfolio-release', updateType: update.type },
          });
        } else {
          // Успешный settlement → снимаем pending cancel marker (Этап 6.3):
          // authoritative terminal update «разрешает» uncertain-cancel placeholder.
          this._clearPendingCancelMarker(orderId);
        }
      }
    }

    // Шаг 6: ENQUEUE OrderEvent[] в ordered outbox (aggregateId=orderId).
    await this._enqueueAndFinish(orderId, accountId, update.type, events);
    return Ok(undefined);
  }

  /**
   * ENQUEUE OrderEvent[] в ordered outbox + финальный лог.
   *
   * @param orderId - venue orderId (aggregateId)
   * @param accountId - ID аккаунта (для issue)
   * @param updateType - Тип update (для лога/issue)
   * @param events - События committed update
   *
   * @remarks
   * Бизнес-коммит уже состоялся (CAS save + возможный reservation release /
   * settlement pending) — публикация (flush ПОСЛЕ lock) является notification
   * path, НЕ частью транзакции. Сбой enqueue НЕ откатывает состояние и НЕ
   * делает committed update retryable: helper логирует EVENT_PUBLISH_FAILED + issue.
   */
  private async _enqueueAndFinish(
    orderId: OrderId,
    accountId: AccountId,
    updateType: string,
    events: readonly unknown[],
  ): Promise<void> {
    await enqueueCommittedEvents({
      outbox: this._deps.orderedEventOutbox,
      logger: this._logger,
      reconciliationIssues: this._deps.reconciliationIssues,
      now: this._deps.clock?.now() ?? new Date(),
      aggregateId: String(orderId),
      events: events as readonly ApplicationEvent[],
      issueContext: {
        issueId: `reconciliation:order-update:${String(orderId)}:outbox-enqueue-failed`,
        stage: 'outbox-enqueue',
        orderId,
        accountId,
        extra: { updateType },
      },
    });

    this._logger.info('Order update applied', {
      orderId: String(orderId),
      updateType,
    });
  }
}
