/**
 * ResolveUnknownSubmissionUseCase — ЯВНОЕ операторское разрешение UNKNOWN submission.
 *
 * @remarks
 * ### Зачем отдельный use case:
 * Discovery (`ReconcileUnknownSubmissionsUseCase`) только находит кандидатов и
 * создаёт issues — все решения (привязка venueOrderId, подтверждение отсутствия)
 * принимает ОПЕРАТОР через этот use case. Смешивать операторское решение с
 * периодическим reconciler нельзя: авто-решение на эвристике может привязать
 * чужой ордер или освободить резервацию живой заявки.
 *
 * ### Резолюции:
 * - `BIND_VENUE_ORDER` + `candidateKind: 'OPEN_ORDER'` — оператор подтверждает,
 *   что live venue-ордер наш: verify через `getOpenOrders` → `markVenueAccepted`.
 *   **Manual block НЕ снимается** — текущего `OpenOrderSnapshot` недостаточно
 *   для восстановления доменного Order (нет strategyId и части исходных
 *   параметров), поэтому блок держится до отдельного recovery локального Order
 *   (пока live venue-ордер не появится в локальном Order repository) →
 *   исход `BOUND_AWAITING_ORDER_RECOVERY`.
 * - `BIND_VENUE_ORDER` + `candidateKind: 'TRADE'` — ордер уже исполнен:
 *   verify через `getTrades` → `markVenueAccepted` → matched/in-flight markers
 *   на КОНКРЕТНЫЕ fillId trade-ов (strategy продолжает видеть unsettled
 *   execution) → только потом снятие manual block → исход `BOUND_AWAITING_FILL`.
 *   Сами fills придут через WS/reconciliation polling и применятся
 *   held-reservation path (`findByVenueOrderId` теперь работает); markers
 *   снимаются `ProcessFillUseCase` после успешного применения.
 * - `CONFIRM_NOT_SUBMITTED` — оператор подтверждает, что заявка на venue не
 *   создавалась: Portfolio release → journal release (`SETTLED`) → `markFailed`
 *   (retry разрешён) → снятие manual block. Любой частичный сбой оставляет
 *   блок, помечает journal `RECONCILIATION_REQUIRED` best-effort и создаёт
 *   issue — retry НЕ разрешается.
 *
 * ### Audit:
 * `operatorId`, `reason` и время решения логируются структурированно и
 * включаются в persisted `reason` записи (`markFailed`) — операторское решение
 * восстановимо из журнала submission.
 *
 * @example
 * ```typescript
 * const resolver = new ResolveUnknownSubmissionUseCase({ ...deps });
 * const r = await resolver.execute({
 *   clientOrderId, accountId,
 *   resolution: { type: 'BIND_VENUE_ORDER', venueOrderId, candidateKind: 'TRADE',
 *     operatorId: 'ops-ivan', reason: 'single trade match verified in venue UI' },
 * });
 * ```
 */
import Decimal from 'decimal.js';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { AccountId, OrderId } from '@polymarket/ids';
import { assetIdToInstrumentId, accountIdToString } from '@polymarket/ids';
import type {
  IExchangeClient,
  IKeyedMutex,
  IOrderStateStore,
  IOrderSubmissionRepository,
  IReconciliationIssueRepository,
  OrderSubmissionRecord,
} from '@polymarket/ports';
import { canConsumeHeldReservation } from '@polymarket/ports';
import type { PortfolioService } from './services/PortfolioService.js';
import { lockKey } from './lockKeys.js';

/** Операторская резолюция UNKNOWN submission. */
export type UnknownSubmissionResolution =
  | {
      readonly type: 'BIND_VENUE_ORDER';
      readonly venueOrderId: OrderId;
      readonly candidateKind: 'OPEN_ORDER' | 'TRADE';
      readonly operatorId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'CONFIRM_NOT_SUBMITTED';
      readonly operatorId: string;
      readonly reason: string;
    };

/** Входные данные ResolveUnknownSubmissionUseCase. */
export interface ResolveUnknownSubmissionInput {
  readonly clientOrderId: OrderId;
  readonly accountId: AccountId;
  readonly resolution: UnknownSubmissionResolution;
}

/**
 * Типизированный исход резолюции.
 *
 * @remarks
 * - `BOUND_AWAITING_ORDER_RECOVERY` — open order привязан, block ОСТАЁТСЯ до
 *   восстановления локального Order.
 * - `BOUND_AWAITING_FILL` — trade привязан, markers поставлены, block снят;
 *   fill применится через WS/reconciliation (held path).
 * - `RELEASED_NOT_SUBMITTED` — резервация освобождена, retry разрешён, block снят.
 * - `RECONCILIATION_REQUIRED` — частичный сбой, block сохранён, issue создана.
 */
export type ResolveUnknownSubmissionOutcome =
  | { readonly status: 'BOUND_AWAITING_ORDER_RECOVERY' }
  | { readonly status: 'BOUND_AWAITING_FILL' }
  | { readonly status: 'RELEASED_NOT_SUBMITTED' }
  | { readonly status: 'RECONCILIATION_REQUIRED'; readonly reason: string };

/** Зависимости ResolveUnknownSubmissionUseCase. */
export interface ResolveUnknownSubmissionDeps {
  readonly submissions: IOrderSubmissionRepository;
  readonly exchangeClient: IExchangeClient;
  readonly portfolioService: PortfolioService;
  readonly orderStateStore: IOrderStateStore;
  /** Те же account/instrument locks, что у Place/Fill/Cancel. */
  readonly keyedMutex: IKeyedMutex;
  readonly clock: IClock;
  readonly logger: ILogger;
  readonly reconciliationIssues?: IReconciliationIssueRepository;
}

/**
 * Use case явного операторского разрешения UNKNOWN submission.
 */
export class ResolveUnknownSubmissionUseCase {
  private readonly _logger: ILogger;

  /**
   * @param _deps - Зависимости use case
   */
  constructor(private readonly _deps: ResolveUnknownSubmissionDeps) {
    this._logger = _deps.logger.child({ component: 'ResolveUnknownSubmissionUseCase' });
  }

  /**
   * Выполняет операторскую резолюцию под account/instrument locks.
   *
   * @param input - `clientOrderId`, `accountId`, `resolution`
   * @returns Ok(outcome) либо Err при невалидном входе/состоянии
   *
   * @throws Не бросает — все ошибки через Result
   */
  public async execute(
    input: ResolveUnknownSubmissionInput,
  ): Promise<Result<ResolveUnknownSubmissionOutcome, TradingError>> {
    // instrumentId нужен для lock-ключей — читаем запись до lock (перечитаем внутри).
    const preflight = await this._deps.submissions.get(input.clientOrderId);
    if (!preflight) {
      return Err(new TradingError(
        `Unknown submission not found: ${String(input.clientOrderId)}`,
        { context: { clientOrderId: String(input.clientOrderId) } },
      ));
    }
    const lockKeys = [
      lockKey.account(input.accountId),
      lockKey.instrument(String(preflight.instrumentId)),
    ];
    return this._deps.keyedMutex.runExclusive(lockKeys, () => this._resolveLocked(input));
  }

  /**
   * Тело резолюции — вызывается ВНУТРИ keyed mutex.
   *
   * @param input - Входные данные
   * @returns Ok(outcome) либо Err
   */
  private async _resolveLocked(
    input: ResolveUnknownSubmissionInput,
  ): Promise<Result<ResolveUnknownSubmissionOutcome, TradingError>> {
    const accountKey = (id: AccountId): string => (typeof id === 'string' ? id : accountIdToString(id));

    // Перечитать и провалидировать состояние ПОД lock.
    const record = await this._deps.submissions.get(input.clientOrderId);
    if (!record) {
      return Err(new TradingError(`Unknown submission not found: ${String(input.clientOrderId)}`, {}));
    }
    if (record.status !== 'UNKNOWN') {
      return Err(new TradingError(
        `Submission is not UNKNOWN (status=${record.status}) — nothing to resolve`,
        { context: { clientOrderId: String(input.clientOrderId), status: record.status } },
      ));
    }
    if (record.venueOrderId !== undefined) {
      return Err(new TradingError(
        `Submission already has venueOrderId (${String(record.venueOrderId)})`,
        { context: { clientOrderId: String(input.clientOrderId) } },
      ));
    }
    if (accountKey(record.accountId) !== accountKey(input.accountId)) {
      return Err(new TradingError(
        'Submission belongs to a different account',
        { context: { clientOrderId: String(input.clientOrderId) } },
      ));
    }

    const resolution = input.resolution;
    this._logger.warn('Operator resolution for unknown submission (audit)', {
      clientOrderId: String(input.clientOrderId),
      resolutionType: resolution.type,
      operatorId: resolution.operatorId,
      operatorReason: resolution.reason,
      resolvedAt: this._deps.clock.now().toISOString(),
      ...(resolution.type === 'BIND_VENUE_ORDER'
        ? { venueOrderId: String(resolution.venueOrderId), candidateKind: resolution.candidateKind }
        : {}),
    });

    if (resolution.type === 'BIND_VENUE_ORDER') {
      // Несовместимая резервация: bind предполагает, что held-резервация будет
      // потреблена fill-ами/восстановленным Order.
      if (record.reservation.status === 'RECONCILIATION_REQUIRED') {
        return Err(new TradingError(
          'Reservation is RECONCILIATION_REQUIRED — resolve journal first',
          { context: { clientOrderId: String(input.clientOrderId) } },
        ));
      }
      const alreadyBound = await this._deps.submissions.findByVenueOrderId(resolution.venueOrderId);
      if (alreadyBound) {
        return Err(new TradingError(
          `venueOrderId ${String(resolution.venueOrderId)} is already bound to submission ${String(alreadyBound.clientOrderId)}`,
          { context: { clientOrderId: String(input.clientOrderId) } },
        ));
      }
      return resolution.candidateKind === 'OPEN_ORDER'
        ? this._bindOpenOrder(input, record, resolution.venueOrderId)
        : this._bindTrade(input, record, resolution.venueOrderId);
    }

    return this._confirmNotSubmitted(input, record, resolution.operatorId, resolution.reason);
  }

  /**
   * BIND_VENUE_ORDER (OPEN_ORDER): verify → bind → block ОСТАЁТСЯ.
   *
   * @param input - Входные данные
   * @param record - Запись под lock
   * @param venueOrderId - Привязываемый venue orderId
   * @returns `BOUND_AWAITING_ORDER_RECOVERY`
   *
   * @remarks
   * Блок нельзя снимать, пока live venue-ордер не восстановлен в локальном
   * Order repository (данных snapshot недостаточно: нет strategyId и части
   * исходных параметров) — иначе Place/strategy начали бы работать поверх
   * невидимого live-ордера.
   */
  private async _bindOpenOrder(
    input: ResolveUnknownSubmissionInput,
    record: OrderSubmissionRecord,
    venueOrderId: OrderId,
  ): Promise<Result<ResolveUnknownSubmissionOutcome, TradingError>> {
    const openResult = await this._safeGetOpenOrders(input.accountId);
    if (!openResult.ok) return openResult;
    const snapshot = openResult.value.find((o) => String(o.orderId) === String(venueOrderId));
    if (!snapshot) {
      return Err(new TradingError(
        `Open order ${String(venueOrderId)} not found on venue — cannot bind as OPEN_ORDER`,
        { context: { clientOrderId: String(input.clientOrderId) } },
      ));
    }
    const mismatch = this._verifyEconomicMatch(record, {
      instrument: assetIdToInstrumentId(snapshot.asset),
      side: snapshot.side,
      price: snapshot.price.value(),
    });
    if (mismatch) {
      return Err(new TradingError(
        `Open order ${String(venueOrderId)} does not match submission: ${mismatch}`,
        { context: { clientOrderId: String(input.clientOrderId) } },
      ));
    }

    try {
      await this._deps.submissions.markVenueAccepted(input.clientOrderId, venueOrderId, this._deps.clock.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(new TradingError(`Failed to bind venueOrderId: ${message}`, {
        context: { clientOrderId: String(input.clientOrderId) },
      }));
    }
    // Manual block НЕ снимается: локального Order ещё нет.
    this._logger.info('Unknown submission bound to LIVE venue order — manual block kept until local Order recovery', {
      clientOrderId: String(input.clientOrderId),
      venueOrderId: String(venueOrderId),
    });
    return Ok({ status: 'BOUND_AWAITING_ORDER_RECOVERY' });
  }

  /**
   * BIND_VENUE_ORDER (TRADE): verify → bind → markers на fillId → снятие блока.
   *
   * @param input - Входные данные
   * @param record - Запись под lock
   * @param venueOrderId - Привязываемый venue orderId
   * @returns `BOUND_AWAITING_FILL`
   *
   * @remarks
   * Markers ставятся ДО снятия manual block — между bind и применением Fill
   * strategy продолжает видеть unsettled execution (`hasUnsettledFills`).
   * Fill придёт через WS/reconciliation polling (после выхода из mutex) и
   * применится held-reservation path; markers снимет `ProcessFillUseCase`
   * после успешного применения.
   */
  private async _bindTrade(
    input: ResolveUnknownSubmissionInput,
    record: OrderSubmissionRecord,
    venueOrderId: OrderId,
  ): Promise<Result<ResolveUnknownSubmissionOutcome, TradingError>> {
    let orderTrades;
    try {
      const tradesResult = await this._deps.exchangeClient.getTrades(input.accountId);
      if (!tradesResult.ok) {
        return Err(new TradingError(
          `Failed to fetch trades to verify TRADE bind: ${tradesResult.error.message}`,
          { context: { clientOrderId: String(input.clientOrderId) } },
        ));
      }
      orderTrades = tradesResult.value.filter((t) => String(t.orderId) === String(venueOrderId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(new TradingError(`Trades fetch threw during TRADE bind: ${message}`, {}));
    }
    if (orderTrades.length === 0) {
      return Err(new TradingError(
        `No venue trades found for ${String(venueOrderId)} — cannot bind as TRADE`,
        { context: { clientOrderId: String(input.clientOrderId) } },
      ));
    }
    for (const trade of orderTrades) {
      const mismatch = this._verifyEconomicMatch(record, {
        instrument: assetIdToInstrumentId(trade.asset),
        side: trade.side,
        price: trade.price.value(),
      });
      if (mismatch) {
        return Err(new TradingError(
          `Trade ${String(trade.fillId)} does not match submission: ${mismatch}`,
          { context: { clientOrderId: String(input.clientOrderId) } },
        ));
      }
    }

    try {
      await this._deps.submissions.markVenueAccepted(input.clientOrderId, venueOrderId, this._deps.clock.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(new TradingError(`Failed to bind venueOrderId: ${message}`, {
        context: { clientOrderId: String(input.clientOrderId) },
      }));
    }

    // Markers для КОНКРЕТНЫХ fillId — ДО снятия manual block: unsettled
    // execution остаётся видимым strategy/Place/Cancel до применения Fill.
    for (const trade of orderTrades) {
      this._deps.orderStateStore.markOrderFillMatched(venueOrderId, trade.fillId);
      this._deps.orderStateStore.markInFlightFill({
        instrumentId: record.instrumentId,
        fillId: trade.fillId,
        orderId: venueOrderId,
        status: 'MATCHED',
      });
    }
    this._deps.orderStateStore.clearManualReconciliationBlock(input.clientOrderId);
    this._logger.info('Unknown submission bound to EXECUTED venue order — fill markers set, manual block cleared', {
      clientOrderId: String(input.clientOrderId),
      venueOrderId: String(venueOrderId),
      fillIds: orderTrades.map((t) => String(t.fillId)),
    });
    return Ok({ status: 'BOUND_AWAITING_FILL' });
  }

  /**
   * CONFIRM_NOT_SUBMITTED: операторски подтверждённое отсутствие заявки.
   *
   * @param input - Входные данные
   * @param record - Запись под lock
   * @param operatorId - ID оператора (audit)
   * @param reason - Причина оператора (audit)
   * @returns `RELEASED_NOT_SUBMITTED` либо `RECONCILIATION_REQUIRED`
   *
   * @remarks
   * Порядок: Portfolio release → journal release (`SETTLED`) → `markFailed`
   * (retry разрешён) → снятие manual block. Частичный сбой: journal →
   * `RECONCILIATION_REQUIRED` best-effort, блок ОСТАЁТСЯ, issue, retry
   * НЕ разрешается (запись остаётся UNKNOWN → `begin()` блокирует).
   */
  private async _confirmNotSubmitted(
    input: ResolveUnknownSubmissionInput,
    record: OrderSubmissionRecord,
    operatorId: string,
    reason: string,
  ): Promise<Result<ResolveUnknownSubmissionOutcome, TradingError>> {
    if (record.reservation.status === 'RECONCILIATION_REQUIRED') {
      return Err(new TradingError(
        'Reservation is RECONCILIATION_REQUIRED — resolve journal first',
        { context: { clientOrderId: String(input.clientOrderId) } },
      ));
    }

    if (canConsumeHeldReservation(record.reservation)) {
      const remaining = new Decimal(record.reservation.remaining);
      const releaseResult = record.reservation.kind === 'USDC'
        ? this._deps.portfolioService.releaseReservation(input.accountId, remaining)
        : this._deps.portfolioService.releaseTokenReservation(input.accountId, record.instrumentId, remaining);
      if (!releaseResult.ok) {
        await this._lockAsReconciliation(record, 'confirm-not-submitted-release-failed',
          `OPERATOR_CONFIRM_NOT_SUBMITTED_RELEASE_FAILED (${operatorId}): ${releaseResult.error.message}`);
        return Ok({
          status: 'RECONCILIATION_REQUIRED',
          reason: `Portfolio release failed: ${releaseResult.error.message}`,
        });
      }
      const journal = await this._applyJournalRelease(record, remaining.toString());
      if (!journal.ok) {
        // Portfolio уже изменён, journal — нет: РАССИНХРОН.
        await this._lockAsReconciliation(record, 'confirm-not-submitted-journal-failed',
          `OPERATOR_CONFIRM_NOT_SUBMITTED_JOURNAL_FAILED (${operatorId}): ${journal.error}`);
        return Ok({
          status: 'RECONCILIATION_REQUIRED',
          reason: `Journal release failed after Portfolio release: ${journal.error}`,
        });
      }
    }

    try {
      await this._deps.submissions.markFailed(
        input.clientOrderId,
        `OPERATOR_CONFIRMED_NOT_SUBMITTED by ${operatorId} at ${this._deps.clock.now().toISOString()}: ${reason}`,
        this._deps.clock.now(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this._lockAsReconciliation(record, 'confirm-not-submitted-mark-failed',
        `OPERATOR_CONFIRM_NOT_SUBMITTED_MARK_FAILED (${operatorId}): ${message}`);
      return Ok({ status: 'RECONCILIATION_REQUIRED', reason: `markFailed threw: ${message}` });
    }
    this._deps.orderStateStore.clearManualReconciliationBlock(input.clientOrderId);
    this._logger.info('Unknown submission resolved by operator as NOT SUBMITTED — reservation released, retry allowed', {
      clientOrderId: String(input.clientOrderId),
      operatorId,
    });
    return Ok({ status: 'RELEASED_NOT_SUBMITTED' });
  }

  /**
   * Частичный сбой резолюции: journal → RECONCILIATION_REQUIRED best-effort,
   * manual block ОСТАЁТСЯ, идемпотентная issue.
   *
   * @param record - Запись журнала
   * @param idSuffix - Суффикс id issue
   * @param reason - Причина (English, включает operatorId)
   */
  private async _lockAsReconciliation(record: OrderSubmissionRecord, idSuffix: string, reason: string): Promise<void> {
    this._logger.error(`${reason} — manual block kept, retry NOT allowed`, {
      clientOrderId: String(record.clientOrderId),
    });
    try {
      const r = await this._deps.submissions.applyReservationTransition(record.clientOrderId, {
        operationId: `attempt:${record.attempt}:${idSuffix}`,
        status: 'RECONCILIATION_REQUIRED',
        now: this._deps.clock.now(),
      });
      if (!r.ok) {
        this._logger.error('Failed to mark journal RECONCILIATION_REQUIRED during operator resolution', {
          clientOrderId: String(record.clientOrderId),
          error: r.error.message,
        });
      }
    } catch (err) {
      this._logger.error('Failed to mark journal RECONCILIATION_REQUIRED during operator resolution (threw)', {
        clientOrderId: String(record.clientOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
    // Manual block намеренно НЕ снимается (fail-closed).
    if (!this._deps.reconciliationIssues) return;
    try {
      await this._deps.reconciliationIssues.add({
        id: `reconciliation:submit-client:${String(record.clientOrderId)}:${idSuffix}`,
        type: 'ORDER_PORTFOLIO_DESYNC',
        status: 'OPEN',
        reason,
        createdAt: this._deps.clock.now(),
        accountId: record.accountId,
        instrumentId: record.instrumentId,
        context: { clientOrderId: String(record.clientOrderId) },
      });
    } catch (err) {
      this._logger.error('Failed to add reconciliation issue during operator resolution', {
        clientOrderId: String(record.clientOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Journal release остатка с проверкой SETTLED.
   *
   * @param record - Запись журнала
   * @param amount - Освобождаемый остаток (decimal-строка)
   * @returns `{ ok: true }` либо `{ ok: false, error }`
   */
  private async _applyJournalRelease(
    record: OrderSubmissionRecord,
    amount: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    try {
      const r = await this._deps.submissions.applyReservationTransition(record.clientOrderId, {
        operationId: `attempt:${record.attempt}:operator-confirm-not-submitted-release`,
        release: amount,
        now: this._deps.clock.now(),
      });
      if (!r.ok) return { ok: false, error: r.error.message };
      const res = r.value.reservation;
      if (res.status !== 'SETTLED' || !new Decimal(res.remaining).isZero()) {
        return { ok: false, error: `journal not settled after release: status=${res.status} remaining=${res.remaining}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Сверка экономических параметров кандидата с записью.
   *
   * @param record - Запись журнала
   * @param candidate - `instrument`, `side`, `price` кандидата
   * @returns Строка несоответствия либо `undefined`, если всё совпало
   */
  private _verifyEconomicMatch(
    record: OrderSubmissionRecord,
    candidate: { instrument: ReturnType<typeof assetIdToInstrumentId>; side: string; price: Decimal },
  ): string | undefined {
    if (!candidate.instrument || String(candidate.instrument) !== String(record.instrumentId)) {
      return `instrument mismatch (candidate=${candidate.instrument ? String(candidate.instrument) : 'unresolved'}, expected=${String(record.instrumentId)})`;
    }
    if (candidate.side !== record.side) {
      return `side mismatch (candidate=${candidate.side}, expected=${record.side})`;
    }
    if (!candidate.price.equals(new Decimal(record.orderPrice))) {
      return `price mismatch (candidate=${candidate.price.toString()}, expected=${record.orderPrice})`;
    }
    return undefined;
  }

  /**
   * Безопасная выборка open orders (Err вместо throw).
   *
   * @param accountId - ID аккаунта
   * @returns Ok(snapshots) либо Err
   */
  private async _safeGetOpenOrders(
    accountId: AccountId,
  ): Promise<Result<readonly import('@polymarket/ports').OpenOrderSnapshot[], TradingError>> {
    try {
      const r = await this._deps.exchangeClient.getOpenOrders(accountId);
      if (!r.ok) {
        return Err(new TradingError(`Failed to fetch open orders to verify bind: ${r.error.message}`, {}));
      }
      return Ok(r.value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(new TradingError(`Open orders fetch threw during bind verification: ${message}`, {}));
    }
  }
}
