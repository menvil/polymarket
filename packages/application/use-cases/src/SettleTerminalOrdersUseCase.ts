/**
 * SettleTerminalOrdersUseCase — разрешение TerminalSettlementPending
 * (delayed-fill окно после авторитетного terminal venue-update).
 *
 * @remarks
 * ### Проблема (Шаг 5):
 * Partial fill мог произойти на venue, а `CANCELLED`/`EXPIRED`/`REJECTED`
 * update прийти ПЕРВЫМ. `UpdateOrderStatusUseCase` при held journal-резервации
 * НЕ освобождает капитал, а ставит {@link TerminalSettlementPending}. Этот use
 * case разрешает pending:
 *
 * 1. Снимок venue trades (`getTrades`) — authoritative список исполнений.
 *    Сбой запроса → pending ОСТАЁТСЯ (timeout/недоступность — НЕ доказательство
 *    отсутствия fill).
 * 2. Для каждого pending (под account/order/instrument mutex):
 *    - все venue trades этого ордера должны быть применены
 *      (`processedFillRepo.getStatus === APPLIED`); непримененные —
 *      обрабатываются `fillProcessor`-ом (held-reservation path: ордер
 *      terminal, journal held) — ошибка → pending остаётся до следующего прогона;
 *    - matched/in-flight fills ордера должны отсутствовать;
 *    - после применения всех trades journal `remaining` — authoritative
 *      остаток: Portfolio release remaining → journal release → `SETTLED`;
 *    - только после Portfolio + journal settlement: снятие pending +
 *      pending-cancel placeholder.
 * 3. Частичный сбой settlement (Portfolio/journal) → manual reconciliation
 *    block + issue (pending конвертируется в операторскую проблему).
 *
 * ### Fail-closed:
 * Если venue не предоставляет authoritative state (trades API Err/throw) —
 * pending остаётся, торговля на инструменте блокирована (`hasUnsettledFills`).
 *
 * @example
 * ```typescript
 * const settler = new SettleTerminalOrdersUseCase({
 *   orderStateStore, submissions, portfolioService, exchangeClient,
 *   processedFillRepo, fillProcessor: processFillUseCase, tradeToFill,
 *   keyedMutex, clock, logger, reconciliationIssues,
 * });
 * await settler.execute({ accountId }); // периодически + после reconnect
 * ```
 */
import Decimal from 'decimal.js';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { AccountId, OrderId } from '@polymarket/ids';
import type {
  IExchangeClient,
  IFillProcessor,
  IKeyedMutex,
  IOrderStateStore,
  IOrderSubmissionRepository,
  IProcessedFillRepository,
  IReconciliationIssueRepository,
  TerminalSettlementPending,
  VenueTradeSnapshot,
} from '@polymarket/ports';
import { pendingMatchFillId, canConsumeHeldReservation } from '@polymarket/ports';
import { accountIdToString } from '@polymarket/ids';
import type { Fill } from '@polymarket/fill';
import type { PortfolioService } from './services/PortfolioService.js';
import { lockKey } from './lockKeys.js';
import { isProcessableVenueTradeStatus, isFailedVenueTradeStatus } from './services/venueTradeStatusPolicy.js';

/** Входные данные SettleTerminalOrdersUseCase. */
export interface SettleTerminalOrdersInput {
  /** ID аккаунта */
  readonly accountId: AccountId;
}

/** Итог одного settle-прогона. */
export interface SettleTerminalOrdersSummary {
  /** Сколько pending записей рассмотрено */
  readonly scanned: number;
  /** Сколько разрешено (Portfolio + journal settled, pending снят) */
  readonly settled: number;
  /** Сколько оставлено pending (trades не применены/недоступны) */
  readonly kept: number;
  /** Сколько конвертировано в manual reconciliation block (частичный сбой) */
  readonly escalated: number;
}

/** Зависимости SettleTerminalOrdersUseCase. */
export interface SettleTerminalOrdersDeps {
  readonly orderStateStore: IOrderStateStore;
  readonly submissions: IOrderSubmissionRepository;
  readonly portfolioService: PortfolioService;
  readonly exchangeClient: IExchangeClient;
  readonly processedFillRepo: IProcessedFillRepository;
  /** Обработчик fill (ProcessFillUseCase) — для запоздавших trades. */
  readonly fillProcessor: IFillProcessor;
  /**
   * Конвертер VenueTradeSnapshot → Fill (переиспользует маппинг
   * ReconcileTradesUseCase; в порт не вынесен намеренно — доменная логика).
   */
  readonly tradeToFill: (trade: VenueTradeSnapshot, accountId: AccountId) => Result<Fill, TradingError>;
  readonly keyedMutex: IKeyedMutex;
  readonly clock: IClock;
  readonly logger: ILogger;
  readonly reconciliationIssues?: IReconciliationIssueRepository;
  /**
   * Минимальный возраст pending (мс) перед попыткой settlement (default 30_000).
   *
   * @remarks
   * Defense-in-depth против eventual-consistency лага venue trades API сразу
   * после terminal update: это НЕ «timeout как доказательство отсутствия fill»
   * (пустой ответ всё равно authoritative только при доступном API), а grace
   * period перед доверием к нему. 0 — без задержки (тесты).
   */
  readonly minSettleDelayMs?: number;
}

/** Дефолтный grace period перед settlement (мс). */
const DEFAULT_MIN_SETTLE_DELAY_MS = 30_000;

/**
 * Use case разрешения terminal settlement pending.
 */
export class SettleTerminalOrdersUseCase {
  private readonly _logger: ILogger;

  /**
   * @param _deps - Зависимости use case
   */
  constructor(private readonly _deps: SettleTerminalOrdersDeps) {
    this._logger = _deps.logger.child({ component: 'SettleTerminalOrdersUseCase' });
  }

  /**
   * Выполняет один settle-прогон.
   *
   * @param input - `accountId`
   * @returns Ok(summary); Err только если pending есть, а trades API недоступен
   *
   * @throws Не бросает — все ошибки через Result
   */
  public async execute(
    input: SettleTerminalOrdersInput,
  ): Promise<Result<SettleTerminalOrdersSummary, TradingError>> {
    // ТОЛЬКО pending нашего аккаунта: settle-резолвер не должен видеть (и тем
    // более освобождать) резервации чужих аккаунтов.
    const pendings = this._deps.orderStateStore.getTerminalSettlementPending(input.accountId);
    if (pendings.length === 0) {
      return Ok({ scanned: 0, settled: 0, kept: 0, escalated: 0 });
    }

    // Authoritative venue trades. Недоступность → все pending остаются
    // (timeout — НЕ доказательство отсутствия fill).
    let trades: readonly VenueTradeSnapshot[];
    try {
      const tradesResult = await this._deps.exchangeClient.getTrades(input.accountId);
      if (!tradesResult.ok) {
        this._logger.warn('Trades fetch failed — terminal settlements kept pending', {
          error: tradesResult.error.message,
          pending: pendings.length,
        });
        return Err(new TradingError(
          `Failed to fetch trades for terminal settlement: ${tradesResult.error.message}`,
          { context: { pending: pendings.length } },
        ));
      }
      trades = tradesResult.value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(new TradingError(`Trades fetch threw during terminal settlement: ${message}`, {}));
    }

    const summary = { scanned: 0, settled: 0, kept: 0, escalated: 0 };
    for (const pending of pendings) {
      summary.scanned++;
      // БЕЗ внешнего mutex: фаза 1 внутри _settleOne вызывает fillProcessor
      // (ProcessFillUseCase), который берёт те же [account, order, instrument]
      // ключи САМ — вложенный захват дал бы deadlock на non-reentrant mutex.
      // Settlement-lock берётся только в фазе 2 (см. _settleOne).
      await this._settleOne(input, pending, trades, summary);
    }

    this._logger.info('Terminal settlement run completed', { ...summary });
    return Ok(summary);
  }

  /**
   * Разрешает один pending в ДВЕ фазы (deadlock-safe).
   *
   * @param input - Входные данные
   * @param pending - Pending запись
   * @param trades - Снимок venue trades
   * @param summary - Мутируемые счётчики
   *
   * @remarks
   * ### Фаза 1 — БЕЗ settlement lock:
   * Непримененные trades прогоняются через `fillProcessor`
   * (`ProcessFillUseCase` берёт [account, order, instrument] mutex САМ —
   * вложенный захват дал бы deadlock). `Ok` от processor НЕ означает
   * «применён» (BUSY/DUPLICATE/RECONCILIATION no-op тоже Ok) — после каждого
   * вызова статус ОБЯЗАТЕЛЬНО перечитывается: только `APPLIED` продолжает,
   * `RECONCILIATION_REQUIRED` эскалирует, остальное (PROCESSING/FAILED/
   * REVERTED/unknown) держит pending до следующего прогона.
   *
   * ### Фаза 2 — settlement ПОД lock:
   * Re-read pending → re-check статусов ВСЕХ trades → matched-evidence →
   * re-read journal → только затем Portfolio release + journal settle +
   * снятие pending/placeholder. Между фазами состояние могло измениться —
   * все проверки повторяются под lock.
   */
  private async _settleOne(
    input: SettleTerminalOrdersInput,
    pending: TerminalSettlementPending,
    trades: readonly VenueTradeSnapshot[],
    summary: { settled: number; kept: number; escalated: number },
  ): Promise<void> {
    // Grace period: даём venue trades API время догнать terminal update
    // (defense-in-depth против eventual-consistency лага; не «timeout как
    // доказательство» — пустой ответ authoritative только при доступном API).
    const minDelayMs = this._deps.minSettleDelayMs ?? DEFAULT_MIN_SETTLE_DELAY_MS;
    const ageMs = this._deps.clock.now().getTime() - pending.receivedAt.getTime();
    if (ageMs < minDelayMs) {
      this._logger.debug('Terminal settlement pending is younger than grace period — kept', {
        orderId: String(pending.orderId),
        ageMs,
        minDelayMs,
      });
      summary.kept++;
      return;
    }

    if (!this._deps.orderStateStore.hasTerminalSettlementPendingForOrder(pending.orderId)) {
      summary.kept++;
      return;
    }

    // ФАЗА 1 (без settlement lock): применить непримененные trades.
    //
    // FAILED-трейды исключаются из орбиты settlement ДО основного цикла:
    // сделка окончательно не прошла on-chain, значит она никогда не станет
    // APPLIED через fillProcessor — если оставить её в `orderTrades`, ниже по
    // коду (и в фазе 2) trade вечно не проходил бы "все APPLIED" gate,
    // навсегда блокируя settlement. Исключение: если trade УЖЕ был применён
    // локально (WS доставил MATCHED/APPLIED раньше, чем venue откатил в
    // FAILED) — это не "пропустить", а desync, требующий эскалации.
    const allOrderTrades = trades.filter((t) => String(t.orderId) === String(pending.orderId));
    const orderTrades: typeof allOrderTrades = [];
    for (const trade of allOrderTrades) {
      if (isFailedVenueTradeStatus(trade.status)) {
        const localStatus = await this._deps.processedFillRepo.getStatus(trade.fillId);
        if (localStatus === 'APPLIED') {
          await this._escalate(input, pending,
            `trade ${String(trade.fillId)} was applied locally but venue reports FAILED — reversal required`);
          summary.escalated++;
          return;
        }
        this._logger.info('Trade FAILED on-chain and never applied locally — excluded from terminal settlement', {
          orderId: String(pending.orderId),
          fillId: String(trade.fillId),
        });
        continue;
      }
      orderTrades.push(trade);
    }

    for (const trade of orderTrades) {
      const status = await this._deps.processedFillRepo.getStatus(trade.fillId);
      if (status === 'APPLIED') continue;
      if (status === 'RECONCILIATION_REQUIRED') {
        // Fill сам требует ручной реконсиляции — settlement невозможен автоматикой.
        await this._escalate(input, pending, `trade ${String(trade.fillId)} is RECONCILIATION_REQUIRED`);
        summary.escalated++;
        return;
      }
      // Settlement необратим (снимает блокировку капитала) — только CONFIRMED
      // (finality) допускается к применению. MATCHED/MINED/RETRYING/undefined
      // ещё могут стать RETRYING/FAILED — весь pending остаётся до следующего
      // прогона (профиль 'settlement' строже, чем 'recovery' у ReconcileTrades).
      if (!isProcessableVenueTradeStatus(trade.status, 'settlement')) {
        this._logger.debug('Trade not yet CONFIRMED on-chain — terminal settlement kept pending', {
          orderId: String(pending.orderId),
          fillId: String(trade.fillId),
          status: trade.status ?? 'undefined',
        });
        summary.kept++;
        return;
      }
      const fillResult = this._deps.tradeToFill(trade, input.accountId);
      if (!fillResult.ok) {
        this._logger.warn('Failed to convert venue trade for terminal settlement — kept pending', {
          orderId: String(pending.orderId),
          fillId: String(trade.fillId),
          error: fillResult.error.message,
        });
        summary.kept++;
        return;
      }
      // fillProcessor берёт свой mutex сам (мы settlement-lock НЕ держим).
      const processResult = await this._deps.fillProcessor.execute(fillResult.value);
      if (!processResult.ok) {
        this._logger.warn('Delayed fill processing failed during terminal settlement — kept pending (retry next run)', {
          orderId: String(pending.orderId),
          fillId: String(trade.fillId),
          error: processResult.error.message,
        });
        summary.kept++;
        return;
      }
      // Ok НЕ означает APPLIED (BUSY/DUPLICATE/RECONCILIATION no-op тоже Ok) —
      // авторитетен ТОЛЬКО перечитанный статус.
      const finalStatus = await this._deps.processedFillRepo.getStatus(trade.fillId);
      if (finalStatus === 'RECONCILIATION_REQUIRED') {
        await this._escalate(input, pending, `trade ${String(trade.fillId)} became RECONCILIATION_REQUIRED during processing`);
        summary.escalated++;
        return;
      }
      if (finalStatus !== 'APPLIED') {
        this._logger.info('Delayed fill not yet APPLIED after processing attempt (status=' + String(finalStatus) + ') — kept pending', {
          orderId: String(pending.orderId),
          fillId: String(trade.fillId),
          finalStatus: String(finalStatus),
        });
        summary.kept++;
        return;
      }
      this._logger.info('Delayed fill applied against held reservation during terminal settlement', {
        orderId: String(pending.orderId),
        fillId: String(trade.fillId),
      });
    }

    // ФАЗА 2 (под settlement lock): re-verify + release + settle.
    const lockKeys = [
      lockKey.account(input.accountId),
      lockKey.order(pending.orderId),
      lockKey.instrument(String(pending.instrumentId)),
    ];
    await this._deps.keyedMutex.runExclusive(lockKeys, async () => {
      await this._finalizeSettlementLocked(input, pending, orderTrades, summary);
    });
  }

  /**
   * Фаза 2: финализация settlement — вызывается ВНУТРИ keyed mutex.
   *
   * @param input - Входные данные
   * @param pending - Pending запись
   * @param orderTrades - Trades этого ордера из снимка прогона
   * @param summary - Мутируемые счётчики
   *
   * @remarks
   * Между фазой 1 и входом в lock состояние могло измениться (конкурентный
   * WS fill, оператор, другой settle-прогон) — все проверки повторяются:
   * pending существует, ВСЕ trades APPLIED, нет matched-evidence, journal
   * перечитан. Только затем release + settle.
   */
  private async _finalizeSettlementLocked(
    input: SettleTerminalOrdersInput,
    pending: TerminalSettlementPending,
    orderTrades: readonly VenueTradeSnapshot[],
    summary: { settled: number; kept: number; escalated: number },
  ): Promise<void> {
    // Re-read pending (мог быть снят/эскалирован конкурентно).
    if (!this._deps.orderStateStore.hasTerminalSettlementPendingForOrder(pending.orderId)) {
      summary.kept++;
      return;
    }

    // Re-check статусов ВСЕХ trades ПОД lock.
    for (const trade of orderTrades) {
      const status = await this._deps.processedFillRepo.getStatus(trade.fillId);
      if (status === 'RECONCILIATION_REQUIRED') {
        await this._escalate(input, pending, `trade ${String(trade.fillId)} is RECONCILIATION_REQUIRED (locked re-check)`);
        summary.escalated++;
        return;
      }
      if (status !== 'APPLIED') {
        summary.kept++;
        return;
      }
    }

    // Не должно оставаться matched/in-flight evidence по этому ордеру
    // (кроме нашего же pending-cancel placeholder, который снимаем ниже).
    const matchedIds = this._deps.orderStateStore.getMatchedFillIds(pending.orderId)
      .filter((id) => String(id) !== String(pendingMatchFillId(pending.orderId)));
    if (matchedIds.length > 0) {
      this._logger.info('Order still has matched fills — terminal settlement kept pending', {
        orderId: String(pending.orderId),
        matchedFillIds: matchedIds.map(String),
      });
      summary.kept++;
      return;
    }

    // Authoritative остаток — journal remaining, перечитанный ПОД lock.
    const record = await this._deps.submissions.findByVenueOrderId(pending.orderId);
    if (record && record.reservation.status === 'RECONCILIATION_REQUIRED') {
      await this._escalate(input, pending, 'journal reservation is RECONCILIATION_REQUIRED');
      summary.escalated++;
      return;
    }
    if (record) {
      // accountId-сверка: journal-запись обязана принадлежать тому же аккаунту,
      // что и pending — иначе release ушёл бы в чужой Portfolio.
      const accountKey = (id: typeof input.accountId): string =>
        typeof id === 'string' ? id : accountIdToString(id);
      if (accountKey(record.accountId) !== accountKey(pending.accountId)) {
        await this._escalate(input, pending,
          `journal record account mismatch (record=${accountKey(record.accountId)}, pending=${accountKey(pending.accountId)})`);
        summary.escalated++;
        return;
      }
    }
    if (record && canConsumeHeldReservation(record.reservation)) {
      const remaining = new Decimal(record.reservation.remaining);
      const releaseResult = record.reservation.kind === 'USDC'
        ? this._deps.portfolioService.releaseReservation(input.accountId, remaining)
        : this._deps.portfolioService.releaseTokenReservation(input.accountId, record.instrumentId, remaining);
      if (!releaseResult.ok) {
        await this._markJournalReconciliationRequired(record.clientOrderId, record.attempt, 'terminal-settle-release-failed');
        await this._escalate(input, pending, `Portfolio release failed: ${releaseResult.error.message}`);
        summary.escalated++;
        return;
      }
      const journal = await this._applyJournalRelease(record, remaining.toString());
      if (!journal.ok) {
        await this._markJournalReconciliationRequired(record.clientOrderId, record.attempt, 'terminal-settle-journal-failed');
        await this._escalate(input, pending, `Journal release failed after Portfolio release: ${journal.error}`);
        summary.escalated++;
        return;
      }
      this._logger.info('Authoritative remaining reservation released on terminal settlement', {
        orderId: String(pending.orderId),
        released: remaining.toString(),
        venueStatus: pending.venueStatus,
      });
    } else if (!record) {
      // Pending ставится только при held journal — отсутствие записи означает
      // потерю данных: операторская проблема.
      await this._escalate(input, pending, 'journal record missing for pending terminal settlement');
      summary.escalated++;
      return;
    }

    // Portfolio + journal settlement подтверждены → снимаем pending +
    // pending-cancel placeholder.
    this._deps.orderStateStore.clearTerminalSettlementPending(pending.orderId);
    const placeholder = pendingMatchFillId(pending.orderId);
    this._deps.orderStateStore.clearOrderFillMatched(pending.orderId, placeholder);
    this._deps.orderStateStore.clearInFlightFill(placeholder);
    summary.settled++;
    this._logger.info('Terminal settlement resolved — block cleared', {
      orderId: String(pending.orderId),
      venueStatus: pending.venueStatus,
    });
  }

  /**
   * Конвертирует pending в manual reconciliation block + issue (частичный сбой).
   *
   * @param input - Входные данные
   * @param pending - Pending запись
   * @param reason - Причина эскалации (English)
   */
  private async _escalate(
    input: SettleTerminalOrdersInput,
    pending: TerminalSettlementPending,
    reason: string,
  ): Promise<void> {
    this._logger.error('Terminal settlement escalated to manual reconciliation', {
      orderId: String(pending.orderId),
      venueStatus: pending.venueStatus,
      reason,
    });
    this._deps.orderStateStore.markManualReconciliationBlock({
      orderId: pending.orderId,
      instrumentId: pending.instrumentId,
      reason: `TERMINAL_SETTLEMENT_ESCALATED: ${reason}`,
    });
    this._deps.orderStateStore.clearTerminalSettlementPending(pending.orderId);
    if (!this._deps.reconciliationIssues) return;
    try {
      await this._deps.reconciliationIssues.add({
        id: `reconciliation:terminal-settle:${String(pending.orderId)}:escalated`,
        type: 'ORDER_PORTFOLIO_DESYNC',
        status: 'OPEN',
        reason: `TERMINAL_SETTLEMENT_ESCALATED: ${reason}`,
        createdAt: this._deps.clock.now(),
        orderId: pending.orderId,
        accountId: input.accountId,
        instrumentId: pending.instrumentId,
        context: { venueStatus: pending.venueStatus, receivedAt: pending.receivedAt.toISOString() },
      });
    } catch (err) {
      this._logger.error('Failed to add escalation issue for terminal settlement', {
        orderId: String(pending.orderId),
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
    record: { readonly clientOrderId: OrderId; readonly attempt: number },
    amount: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    try {
      const r = await this._deps.submissions.applyReservationTransition(record.clientOrderId, {
        operationId: `attempt:${record.attempt}:terminal-settle-release`,
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
   * Best-effort перевод журнала в RECONCILIATION_REQUIRED.
   *
   * @param clientOrderId - clientOrderId записи
   * @param attempt - Текущий attempt (для operationId)
   * @param operationSuffix - Суффикс operationId
   */
  private async _markJournalReconciliationRequired(
    clientOrderId: OrderId,
    attempt: number,
    operationSuffix: string,
  ): Promise<void> {
    try {
      const r = await this._deps.submissions.applyReservationTransition(clientOrderId, {
        operationId: `attempt:${attempt}:${operationSuffix}`,
        status: 'RECONCILIATION_REQUIRED',
        now: this._deps.clock.now(),
      });
      if (!r.ok) {
        this._logger.error('Failed to mark journal RECONCILIATION_REQUIRED during terminal settlement', {
          clientOrderId: String(clientOrderId),
          error: r.error.message,
        });
      }
    } catch (err) {
      this._logger.error('Failed to mark journal RECONCILIATION_REQUIRED during terminal settlement (threw)', {
        clientOrderId: String(clientOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
