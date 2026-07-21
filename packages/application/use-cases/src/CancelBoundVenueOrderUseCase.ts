/**
 * CancelBoundVenueOrderUseCase — операторская отмена привязанного live venue-ордера
 * БЕЗ локального Order aggregate.
 *
 * @remarks
 * ### Закрытие workflow `BOUND_AWAITING_ORDER_RECOVERY`:
 * После `ResolveUnknownSubmissionUseCase` (BIND open order) submission находится
 * в `VENUE_ACCEPTED` с venueOrderId, но локального Order нет и manual block
 * держит инструмент. Этот use case — явная операторская процедура выхода:
 * отменить live venue-ордер и освободить капитал (альтернатива восстановлению
 * локального Order, которое требует отдельного recovery-процесса).
 *
 * ### Порядок (venue-first, под locks):
 * 1. Re-read под [account, order, instrument] mutex: `VENUE_ACCEPTED`,
 *    venueOrderId задан, account совпадает, локального Order НЕТ (иначе —
 *    обычный `CancelOrderUseCase`), reservation не `RECONCILIATION_REQUIRED`.
 * 2. `cancelOrder(venueOrderId)` (exception boundary):
 *    - `CANCELLED`/`ALREADY_CANCELLED` → held-остаток НЕ освобождается сразу
 *      (delayed-fill race — та же причина, что и у `TerminalSettlementPending`
 *      в `UpdateOrderStatusUseCase`): ставим `TerminalSettlementPending` +
 *      blocking placeholder → `markCancelled` (retry под этим clientOrderId
 *      запрещён навсегда — venue-ордер ДЕЙСТВИТЕЛЬНО существовал, в отличие
 *      от `FAILED`) → снятие manual block (delayed Fill должен пройти) →
 *      `CANCELLED_SETTLEMENT_PENDING`. Authoritative release остатка
 *      выполнит `SettleTerminalOrdersUseCase` после применения venue trades.
 *      Частичный сбой (markCancelled бросил) → блок ОСТАЁТСЯ, issue →
 *      `RECONCILIATION_REQUIRED`.
 *    - `ALREADY_FILLED` → ордер исполнен: placeholder markers (fill придёт
 *      held-reservation path — venueOrderId уже привязан) → снятие manual
 *      block → `FILL_PENDING`.
 *    - `NOT_FOUND`/`UNKNOWN_RETRY_NEEDED`/transport → блок ОСТАЁТСЯ, issue →
 *      `RECONCILIATION_REQUIRED` (NOT_FOUND не доказывает отсутствие fill).
 *
 * ### Audit:
 * operatorId/reason/время — в структурном логе и persisted `reason` записи.
 *
 * @example
 * ```typescript
 * const canceller = new CancelBoundVenueOrderUseCase({ ...deps });
 * const r = await canceller.execute({
 *   clientOrderId, accountId, operatorId: 'ops-ivan', reason: 'stray live order, closing',
 * });
 * ```
 */
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { AccountId, OrderId } from '@polymarket/ids';
import { accountIdToString } from '@polymarket/ids';
import type {
  IExchangeClient,
  IKeyedMutex,
  IOrderRepository,
  IOrderStateStore,
  IOrderSubmissionRepository,
  IReconciliationIssueRepository,
  OrderSubmissionRecord,
} from '@polymarket/ports';
import { pendingMatchFillId, canConsumeHeldReservation, ExchangeError } from '@polymarket/ports';
import type { PortfolioService } from './services/PortfolioService.js';
import { lockKey } from './lockKeys.js';

/** Входные данные CancelBoundVenueOrderUseCase. */
export interface CancelBoundVenueOrderInput {
  readonly clientOrderId: OrderId;
  readonly accountId: AccountId;
  /** ID оператора (audit). */
  readonly operatorId: string;
  /** Причина решения (audit). */
  readonly reason: string;
}

/**
 * Типизированный исход отмены привязанного venue-ордера.
 *
 * @remarks
 * - `CANCELLED_SETTLEMENT_PENDING` — venue подтвердил отмену; `markCancelled`
 *   применён (retry под этим clientOrderId запрещён навсегда), manual block
 *   снят. Held-остаток (если был) НЕ освобождён немедленно — ждёт
 *   `SettleTerminalOrdersUseCase` (delayed-fill race window).
 * - `FILL_PENDING` — ордер уже исполнен: markers поставлены, block снят,
 *   fill применится held-reservation path.
 * - `RECONCILIATION_REQUIRED` — неоднозначный venue-исход либо частичный сбой
 *   settlement: block ОСТАЁТСЯ, issue создана.
 */
export type CancelBoundVenueOrderOutcome =
  | { readonly status: 'CANCELLED_SETTLEMENT_PENDING' }
  | { readonly status: 'FILL_PENDING' }
  | { readonly status: 'RECONCILIATION_REQUIRED'; readonly reason: string };

/** Зависимости CancelBoundVenueOrderUseCase. */
export interface CancelBoundVenueOrderDeps {
  readonly submissions: IOrderSubmissionRepository;
  readonly exchangeClient: IExchangeClient;
  readonly portfolioService: PortfolioService;
  readonly orderStateStore: IOrderStateStore;
  readonly orderRepo: IOrderRepository;
  readonly keyedMutex: IKeyedMutex;
  readonly clock: IClock;
  readonly logger: ILogger;
  readonly reconciliationIssues?: IReconciliationIssueRepository;
}

/**
 * Use case операторской отмены привязанного live venue-ордера без локального Order.
 */
export class CancelBoundVenueOrderUseCase {
  private readonly _logger: ILogger;

  /**
   * @param _deps - Зависимости use case
   */
  constructor(private readonly _deps: CancelBoundVenueOrderDeps) {
    this._logger = _deps.logger.child({ component: 'CancelBoundVenueOrderUseCase' });
  }

  /**
   * Выполняет операторскую отмену под account/order/instrument locks.
   *
   * @param input - `clientOrderId`, `accountId`, `operatorId`, `reason`
   * @returns Ok(outcome) либо Err при невалидном входе/состоянии
   *
   * @throws Не бросает — все ошибки через Result
   */
  public async execute(
    input: CancelBoundVenueOrderInput,
  ): Promise<Result<CancelBoundVenueOrderOutcome, TradingError>> {
    const preflight = await this._deps.submissions.get(input.clientOrderId);
    if (!preflight || !preflight.venueOrderId) {
      return Err(new TradingError(
        `Bound submission not found or has no venueOrderId: ${String(input.clientOrderId)}`,
        { context: { clientOrderId: String(input.clientOrderId) } },
      ));
    }
    const lockKeys = [
      lockKey.account(input.accountId),
      lockKey.order(preflight.venueOrderId),
      lockKey.instrument(String(preflight.instrumentId)),
    ];
    return this._deps.keyedMutex.runExclusive(lockKeys, () => this._cancelLocked(input));
  }

  /**
   * Тело отмены — вызывается ВНУТРИ keyed mutex.
   *
   * @param input - Входные данные
   * @returns Ok(outcome) либо Err
   */
  private async _cancelLocked(
    input: CancelBoundVenueOrderInput,
  ): Promise<Result<CancelBoundVenueOrderOutcome, TradingError>> {
    const accountKey = (id: AccountId): string => (typeof id === 'string' ? id : accountIdToString(id));

    // Re-read и валидация ПОД lock.
    const record = await this._deps.submissions.get(input.clientOrderId);
    if (!record || !record.venueOrderId) {
      return Err(new TradingError(`Bound submission not found: ${String(input.clientOrderId)}`, {}));
    }
    const venueOrderId = record.venueOrderId;
    if (record.status !== 'VENUE_ACCEPTED') {
      return Err(new TradingError(
        `Submission is not VENUE_ACCEPTED (status=${record.status}) — use regular cancel flow`,
        { context: { clientOrderId: String(input.clientOrderId), status: record.status } },
      ));
    }
    if (accountKey(record.accountId) !== accountKey(input.accountId)) {
      return Err(new TradingError('Submission belongs to a different account', {
        context: { clientOrderId: String(input.clientOrderId) },
      }));
    }
    const localOrder = await this._deps.orderRepo.get(venueOrderId);
    if (localOrder) {
      return Err(new TradingError(
        `Local Order exists for ${String(venueOrderId)} — use CancelOrderUseCase`,
        { context: { clientOrderId: String(input.clientOrderId), venueOrderId: String(venueOrderId) } },
      ));
    }
    if (record.reservation.status === 'RECONCILIATION_REQUIRED') {
      return Err(new TradingError(
        'Reservation is RECONCILIATION_REQUIRED — resolve journal first',
        { context: { clientOrderId: String(input.clientOrderId) } },
      ));
    }

    this._logger.warn('Operator cancel of bound venue order (audit)', {
      clientOrderId: String(input.clientOrderId),
      venueOrderId: String(venueOrderId),
      operatorId: input.operatorId,
      operatorReason: input.reason,
      resolvedAt: this._deps.clock.now().toISOString(),
    });

    // Venue-first cancel (exception boundary).
    let cancelResult: Awaited<ReturnType<IExchangeClient['cancelOrder']>>;
    try {
      cancelResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cancelResult = Err(new ExchangeError(`cancelOrder threw: ${message}`));
    }

    if (!cancelResult.ok) {
      await this._addIssue(record, 'cancel-bound-transport-error',
        `CANCEL_BOUND_VENUE_ORDER_TRANSPORT_ERROR (${input.operatorId}): ${cancelResult.error.message}`);
      return Ok({ status: 'RECONCILIATION_REQUIRED', reason: `transport error: ${cancelResult.error.message}` });
    }

    const outcome = cancelResult.value;
    switch (outcome.status) {
      case 'CANCELLED':
      case 'ALREADY_CANCELLED':
        return this._deferCancelToSettlement(input, record, venueOrderId);
      case 'ALREADY_FILLED': {
        // Ордер исполнен: fill придёт held-reservation path (venueOrderId
        // привязан) — placeholder markers держат unsettled evidence, manual
        // block снимается (fill не должен блокироваться).
        const placeholder = pendingMatchFillId(venueOrderId);
        this._deps.orderStateStore.markOrderFillMatched(venueOrderId, placeholder);
        this._deps.orderStateStore.markInFlightFill({
          instrumentId: record.instrumentId,
          fillId: placeholder,
          orderId: venueOrderId,
          status: 'MATCHED',
        });
        this._deps.orderStateStore.clearManualReconciliationBlock(input.clientOrderId);
        this._logger.info('Bound venue order already filled — awaiting fill via held-reservation path', {
          clientOrderId: String(input.clientOrderId),
          venueOrderId: String(venueOrderId),
        });
        return Ok({ status: 'FILL_PENDING' });
      }
      case 'NOT_FOUND':
      case 'UNKNOWN_RETRY_NEEDED': {
        // НЕ подтверждение отмены (NOT_FOUND не доказывает отсутствие fill).
        await this._addIssue(record, 'cancel-bound-uncertain',
          `CANCEL_BOUND_VENUE_ORDER_UNCERTAIN (${input.operatorId}): ${outcome.status}: ${(outcome as { reason?: string }).reason ?? ''}`);
        return Ok({ status: 'RECONCILIATION_REQUIRED', reason: `${outcome.status}` });
      }
    }
  }

  /**
   * После подтверждённой venue-отмены: defer settlement (НЕ release сразу) →
   * `markCancelled` → снятие блока.
   *
   * @param input - Входные данные
   * @param record - Запись под lock
   * @param venueOrderId - venue orderId
   * @returns `CANCELLED_SETTLEMENT_PENDING` либо `RECONCILIATION_REQUIRED`
   *
   * @remarks
   * Held-остаток (если был) НЕ освобождается здесь — та же delayed-fill race,
   * что и в `UpdateOrderStatusUseCase` (partial fill мог случиться на venue
   * до/во время cancel, а событие о нём ещё не дошло локально): немедленный
   * release завысил бы available, а последующий delayed fill дебетовал бы
   * его второй раз. Вместо release ставится `TerminalSettlementPending` +
   * blocking placeholder — authoritative остаток освободит
   * `SettleTerminalOrdersUseCase` после применения всех venue trades.
   */
  private async _deferCancelToSettlement(
    input: CancelBoundVenueOrderInput,
    record: OrderSubmissionRecord,
    venueOrderId: OrderId,
  ): Promise<Result<CancelBoundVenueOrderOutcome, TradingError>> {
    const hadHeldReservation = canConsumeHeldReservation(record.reservation);
    if (hadHeldReservation) {
      this._deps.orderStateStore.markTerminalSettlementPending({
        accountId: input.accountId,
        orderId: venueOrderId,
        instrumentId: record.instrumentId,
        venueStatus: 'CANCELLED',
        receivedAt: this._deps.clock.now(),
      });
      const placeholder = pendingMatchFillId(venueOrderId);
      this._deps.orderStateStore.markOrderFillMatched(venueOrderId, placeholder);
      this._deps.orderStateStore.markInFlightFill({
        instrumentId: record.instrumentId,
        fillId: placeholder,
        orderId: venueOrderId,
        status: 'MATCHED',
      });
    }

    try {
      await this._deps.submissions.markCancelled(
        input.clientOrderId,
        `OPERATOR_CANCELLED_BOUND_VENUE_ORDER by ${input.operatorId} at ${this._deps.clock.now().toISOString()}: ${input.reason}`,
        this._deps.clock.now(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this._addIssue(record, 'cancel-bound-mark-cancelled-failed',
        `CANCEL_BOUND_VENUE_ORDER_MARK_CANCELLED_FAILED (${input.operatorId}): ${message}`);
      return Ok({ status: 'RECONCILIATION_REQUIRED', reason: `markCancelled threw: ${message}` });
    }
    // Delayed Fill должен пройти держит evidence сам placeholder/pending —
    // manual block снимается для этого.
    this._deps.orderStateStore.clearManualReconciliationBlock(input.clientOrderId);
    this._logger.info('Bound venue order cancelled by operator — settlement deferred (authoritative release by SettleTerminalOrdersUseCase)', {
      clientOrderId: String(input.clientOrderId),
      venueOrderId: String(venueOrderId),
      operatorId: input.operatorId,
      hadHeldReservation,
    });
    return Ok({ status: 'CANCELLED_SETTLEMENT_PENDING' });
  }

  /**
   * Best-effort идемпотентная reconciliation issue.
   *
   * @param record - Запись журнала (context)
   * @param idSuffix - Детерминированный суффикс id
   * @param reason - Причина (English, включает operatorId)
   */
  private async _addIssue(record: OrderSubmissionRecord, idSuffix: string, reason: string): Promise<void> {
    this._logger.error(`${reason} — manual block kept`, { clientOrderId: String(record.clientOrderId) });
    if (!this._deps.reconciliationIssues) return;
    try {
      await this._deps.reconciliationIssues.add({
        id: `reconciliation:submit-client:${String(record.clientOrderId)}:${idSuffix}`,
        type: 'CANCEL_UNKNOWN_OUTCOME',
        status: 'OPEN',
        reason,
        createdAt: this._deps.clock.now(),
        ...(record.venueOrderId ? { orderId: record.venueOrderId } : {}),
        accountId: record.accountId,
        instrumentId: record.instrumentId,
        context: { clientOrderId: String(record.clientOrderId) },
      });
    } catch (err) {
      this._logger.error('Failed to add reconciliation issue during bound-order cancel', {
        clientOrderId: String(record.clientOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
