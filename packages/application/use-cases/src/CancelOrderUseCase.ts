/**
 * CancelOrderUseCase — venue-first оркестрация отмены торгового ордера.
 *
 * @remarks
 * ### Venue-first алгоритм:
 * 1. Быстрый предварительный lookup Order (вне lock) — fail fast, если ордера нет.
 * 2. Keyed mutex по [account, order, instrument] — сериализует относительно
 *    `ProcessFillUseCase`.
 * 3. Внутри lock: свежий lookup Order + version; guard-ы terminal/matched/in-flight.
 * 4. **Сначала** запрос отмены на venue (`exchangeClient.cancelOrder`), и только
 *    ПОСЛЕ типизированного venue-исхода решаем, менять ли локальное состояние:
 *    - `CANCELLED`/`ALREADY_CANCELLED` → `order.cancel()` + CAS save + release
 *      remaining + journal release + enqueue events.
 *    - `ALREADY_FILLED` → локальный Order НЕ переводим в CANCELED, резервацию НЕ
 *      освобождаем; ставим matched + instrument-block; ждём Fill (`FILL_PENDING`).
 *    - `NOT_FOUND` / `UNKNOWN_RETRY_NEEDED` / transport error / брошенное
 *      исключение → НЕ подтверждение отмены: локально НЕ меняем, резервация held,
 *      reconciliation issue + instrument-block (`RECONCILIATION_REQUIRED`).
 * 5. События enqueue-ятся под lock (aggregateId=orderId), flush — ПОСЛЕ выхода
 *    из lock (никаких publishAll под mutex).
 *
 * ### Почему venue-first:
 * Локальный CANCELED + release ДО подтверждения venue освобождал бы капитал,
 * когда venue-ордер на самом деле уже matched (`ALREADY_FILLED`) или его судьба
 * неизвестна (`NOT_FOUND`/transport). Резервация освобождается ТОЛЬКО когда
 * достоверно известно, что venue-ордер больше не может исполниться.
 *
 * @example
 * ```typescript
 * const useCase = new CancelOrderUseCase({
 *   portfolioService, orderRepo, orderStateStore, keyedMutex, exchangeClient,
 *   orderedEventOutbox, submissions, logger,
 * });
 * const result = await useCase.execute({ orderId, accountId, reason: 'Risk limit' });
 * if (result.ok && result.value.status === 'RECONCILIATION_REQUIRED') { ... }
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { AccountId, OrderId } from '@polymarket/ids';
import { assetIdToInstrumentId } from '@polymarket/ids';
import { lockKey } from './lockKeys.js';
import type {
  IOrderRepository,
  IOrderStateStore,
  IExchangeClient,
  IKeyedMutex,
  IReconciliationIssueRepository,
  ReconciliationIssue,
  IOrderedEventOutbox,
  IOrderSubmissionRepository,
} from '@polymarket/ports';
import { pendingMatchFillId } from '@polymarket/ports';
import type { Order } from '@polymarket/order';
import type { PortfolioService } from './services/PortfolioService.js';
import { enqueueCommittedEvents } from './services/enqueueCommittedEvents.js';

/** Входные данные для CancelOrderUseCase */
export interface CancelOrderInput {
  /** ID ордера для отмены */
  readonly orderId: OrderId;
  /** ID аккаунта владельца ордера */
  readonly accountId: AccountId;
  /** Причина отмены (опционально) */
  readonly reason?: string;
}

/**
 * Типизированный исход отмены.
 *
 * @remarks
 * - `CANCELLED` / `ALREADY_CANCELLED` — venue подтвердил (или локально уже
 *   CANCELED), локально committed.
 * - `ALREADY_FILLED` — локальный ордер уже FILLED: отменять нечего, но это НЕ
 *   отмена — экспозиция получена.
 * - `ALREADY_TERMINAL` — локальный ордер уже REJECTED/EXPIRED (см. `orderStatus`).
 * - `FILL_PENDING` — venue вернул ALREADY_FILLED (или локально matched/in-flight):
 *   ордер НЕ отменён, ждём Fill.
 * - `RECONCILIATION_REQUIRED` — исход venue неоднозначен (NOT_FOUND/UNKNOWN/
 *   transport): резервация held, нужна ручная реконсиляция. НЕ подтверждение отмены.
 */
export type CancelOrderOutcome =
  | { readonly status: 'CANCELLED' }
  | { readonly status: 'ALREADY_CANCELLED' }
  | { readonly status: 'ALREADY_FILLED' }
  | { readonly status: 'ALREADY_TERMINAL'; readonly orderStatus: 'REJECTED' | 'EXPIRED' }
  | { readonly status: 'FILL_PENDING' }
  | { readonly status: 'RECONCILIATION_REQUIRED'; readonly reason: string };

/** Классификация неоднозначного venue-исхода (для issue/логов). */
type UncertainOutcome = 'NOT_FOUND' | 'UNKNOWN_RETRY_NEEDED' | 'TRANSPORT_ERROR';

/** Зависимости CancelOrderUseCase */
export interface CancelOrderDeps {
  readonly portfolioService: PortfolioService;
  readonly orderRepo: IOrderRepository;
  readonly orderStateStore: IOrderStateStore;
  readonly keyedMutex: IKeyedMutex;
  readonly exchangeClient: IExchangeClient;
  /**
   * Ordered event outbox — cancel-события enqueue-ятся под lock (aggregateId=orderId),
   * flush ПОСЛЕ выхода из lock. Заменяет прямой `eventBus.publishAll` под mutex.
   */
  readonly orderedEventOutbox: IOrderedEventOutbox;
  /**
   * Submission guard + reservation journal — при подтверждённой отмене
   * освобождает остаток резервации в журнале (release → SETTLED), best-effort.
   */
  readonly submissions: IOrderSubmissionRepository;
  readonly logger: ILogger;
  /**
   * Queryable хранилище reconciliation issues (опционально).
   *
   * @remarks
   * Optional — чтобы не ломать существующие конструкторы/тесты: без него
   * поведение прежнее (только logging). Если передан, ambiguous venue cancel
   * после УЖЕ выполненного локального cancel создаёт `CANCEL_UNKNOWN_OUTCOME`
   * issue (исходы `UNKNOWN_RETRY_NEEDED` и транспортная/API ошибка) — venue
   * order может быть live, а локально он уже CANCELED. Сбой `add()`
   * логируется и НЕ меняет результат use case.
   */
  readonly reconciliationIssues?: IReconciliationIssueRepository;
  /**
   * Источник времени для `ReconciliationIssue.createdAt` (опционально).
   *
   * @remarks
   * Optional по той же причине. Без него используется `new Date()`
   * (только для createdAt issue — trading flow времени не использует).
   */
  readonly clock?: IClock;
}

/**
 * Use case отмены торгового ордера.
 *
 * @remarks
 * Оркестрирует отмену ордера с откатом резервации баланса
 * и best-effort запросом к бирже.
 */
export class CancelOrderUseCase {
  private readonly _logger: ILogger;

  /**
   * @param deps - Зависимости use case
   */
  constructor(private readonly _deps: CancelOrderDeps) {
    this._logger = _deps.logger.child({ component: 'CancelOrderUseCase' });
  }

  /**
   * Best-effort создание reconciliation issue (CANCEL_UNKNOWN_OUTCOME).
   *
   * @param issue - Issue с детерминированным id (см. call sites)
   *
   * @remarks
   * No-op, если `reconciliationIssues` не передан в deps (optional dependency —
   * прежнее поведение сохраняется). `add()` идемпотентен по id — повторный
   * вызов того же сценария не создаёт дубль. Любая ошибка `add()` логируется
   * и проглатывается: issue — вторичный alerting-механизм, он не должен
   * менять результат use case (локальный cancel уже committed → Ok).
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
   * Маппит terminal-статус локального Order в типизированный исход отмены.
   *
   * @param status - Терминальный `OrderStatus`
   * @returns `ALREADY_CANCELLED` (CANCELED), `ALREADY_FILLED` (FILLED),
   *   `ALREADY_TERMINAL` (REJECTED/EXPIRED)
   *
   * @remarks
   * Раньше ЛЮБОЙ terminal возвращал `ALREADY_CANCELLED` — caller (ExecutionEngine)
   * засчитывал FILLED-ордер как успешную отмену и ставил post-cancel cooldown,
   * хотя экспозиция уже получена.
   */
  private _terminalOutcome(status: Order['status']): CancelOrderOutcome {
    switch (status) {
      case 'CANCELED':
        return { status: 'ALREADY_CANCELLED' };
      case 'FILLED':
        return { status: 'ALREADY_FILLED' };
      case 'REJECTED':
      case 'EXPIRED':
        return { status: 'ALREADY_TERMINAL', orderStatus: status };
      default:
        // Не-терминальный статус сюда не попадает (guard isTerminal у caller);
        // защитный fallback — консервативный ALREADY_CANCELLED.
        return { status: 'ALREADY_CANCELLED' };
    }
  }

  /**
   * Выполняет venue-first отмену ордера.
   *
   * @param input - Входные данные с orderId и accountId
   * @returns Ok(CancelOrderOutcome) — типизированный исход (см. {@link CancelOrderOutcome});
   *   `RECONCILIATION_REQUIRED`/`FILL_PENDING` НЕ означают подтверждённую отмену.
   *   Err — только если ордер вообще не найден.
   *
   * @remarks
   * События enqueue-ятся под lock, публикуются (`flush`) ПОСЛЕ выхода из lock.
   */
  public async execute(input: CancelOrderInput): Promise<Result<CancelOrderOutcome, TradingError>> {
    // Быстрый lookup вне lock — fail fast, если ордера вообще нет.
    // instrumentId нужен для ключа блокировки; берём его из этого lookup.
    const preflightOrder = await this._deps.orderRepo.get(input.orderId);
    if (!preflightOrder) {
      this._logger.warn('Order not found for cancellation', { orderId: String(input.orderId) });
      return Err(new TradingError(
        `Order not found: ${String(input.orderId)}`,
        { context: { orderId: String(input.orderId) } },
      ));
    }

    const instrumentId = assetIdToInstrumentId(preflightOrder.asset);
    // Namespaced keys (lockKey.*) — пересечение с Place ([account,instrument]),
    // Fill/Update по общим сущностям (см. lockKeys.ts).
    const lockKeys = [
      lockKey.account(input.accountId),
      lockKey.order(input.orderId),
      lockKey.instrument(instrumentId ? String(instrumentId) : String(preflightOrder.asset)),
    ];

    const result = await this._deps.keyedMutex.runExclusive(lockKeys, () => this._cancelLocked(input, instrumentId));
    // flush() ВНЕ lock: публикует enqueued cancel-события (никогда не бросает).
    await this._deps.orderedEventOutbox.flush();
    return result;
  }

  /**
   * Тело venue-first отмены — вызывается ВНУТРИ keyed mutex.
   *
   * @param input - Входные данные с orderId и accountId
   * @param instrumentId - InstrumentId ордера (для in-flight проверки), либо undefined
   * @returns Ok(CancelOrderOutcome) или Err(TradingError) если ордер не найден
   */
  private async _cancelLocked(
    input: CancelOrderInput,
    instrumentId: ReturnType<typeof assetIdToInstrumentId>,
  ): Promise<Result<CancelOrderOutcome, TradingError>> {
    // Свежий lookup — состояние могло измениться, пока ждали lock
    // (например, ProcessFillUseCase уже применил fill и освободил lock).
    // getWithVersion() читает Order и версию атомарно (без yield-окна между
    // двумя отдельными await) — версия гарантированно относится к ТОЙ ЖЕ
    // записи, что и order. Раздельные get()+getVersion() не давали такой
    // гарантии: конкурирующая мутация между ними могла бы вызвать ложный
    // CAS-конфликт ниже (не потерю данных, но лишний Err/no-op).
    const snapshot = await this._deps.orderRepo.getWithVersion(input.orderId);
    const order = snapshot?.order;
    const expectedVersion = snapshot?.version ?? 0;
    if (!order) {
      this._logger.warn('Order not found for cancellation', { orderId: String(input.orderId) });
      return Err(new TradingError(
        `Order not found: ${String(input.orderId)}`,
        { context: { orderId: String(input.orderId) } },
      ));
    }

    // Уже в терминальном статусе — идемпотентный выход (venue-запрос не нужен).
    // Terminal statuses РАЗЛИЧАЮТСЯ (Шаг 6): FILLED — не отмена (экспозиция
    // получена), REJECTED/EXPIRED — не отмена (ордер умер сам).
    if (order.isTerminal) {
      this._logger.debug('Order already in terminal status, skipping cancel', {
        orderId: String(input.orderId),
        status: order.status,
      });
      return Ok(this._terminalOutcome(order.status));
    }

    // Matched fills на ордере — fill уже исполнен/в пути. НЕ отменяем (fill идёт),
    // ждём его через ProcessFillUseCase. Резервацию НЕ трогаем.
    if (this._deps.orderStateStore.hasMatchedFills(input.orderId)) {
      this._logger.info('Order has matched fills — skipping cancel, fill pending', {
        orderId: String(input.orderId),
        status: order.status,
        matchedFillIds: this._deps.orderStateStore.getMatchedFillIds(input.orderId).map(String),
      });
      return Ok({ status: 'FILL_PENDING' });
    }

    // Unsettled fills на инструменте (venue in-flight ЛИБО application
    // processing-блок FAILED_RETRYABLE/RECONCILIATION_REQUIRED) — fill в пути или
    // не долит до конца; отмена вызвала бы race/desync.
    if (instrumentId && this._deps.orderStateStore.hasUnsettledFills(instrumentId)) {
      this._logger.info('Instrument has unsettled fills — skipping cancel, fill pending', {
        orderId: String(input.orderId),
        instrumentId: String(instrumentId),
        inFlightFillIds: this._deps.orderStateStore.getInFlightFills(instrumentId).map((f) => String(f.fillId)),
        processingBlocks: this._deps.orderStateStore.getFillProcessingBlocks(instrumentId).map((b) => `${String(b.fillId)}:${b.status}`),
      });
      return Ok({ status: 'FILL_PENDING' });
    }

    // VENUE-FIRST: запрос отмены на venue ДО любой локальной мутации. Только по
    // типизированному venue-исходу решаем, менять ли Order/резервацию.
    // Брошенное исключение трактуем как transport unknown (не подтверждение).
    let exchangeResult: Awaited<ReturnType<IExchangeClient['cancelOrder']>>;
    try {
      exchangeResult = await this._deps.exchangeClient.cancelOrder(input.orderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('Exchange cancel threw — treating as transport unknown (reservation held)', {
        orderId: String(input.orderId),
        error: message,
      });
      return this._handleUncertainVenueCancel(input, instrumentId, `THROWN: ${message}`, 'TRANSPORT_ERROR');
    }

    if (!exchangeResult.ok) {
      this._logger.error('Exchange cancel failed — venue outcome unknown, reservation held', {
        orderId: String(input.orderId),
        error: exchangeResult.error.message,
      });
      return this._handleUncertainVenueCancel(input, instrumentId, exchangeResult.error.message, 'TRANSPORT_ERROR');
    }

    const outcome = exchangeResult.value;
    switch (outcome.status) {
      case 'CANCELLED':
      case 'ALREADY_CANCELLED':
        return this._commitConfirmedCancel(input, order, expectedVersion, instrumentId, outcome.status);
      case 'ALREADY_FILLED':
        return this._handleAlreadyFilled(input, instrumentId, outcome.reason);
      case 'NOT_FOUND':
        // NOT_FOUND НЕ является подтверждением отмены (ордер мог существовать —
        // gateway/lag). Резервацию НЕ освобождаем.
        return this._handleUncertainVenueCancel(input, instrumentId, outcome.reason ?? 'not found on venue', 'NOT_FOUND');
      case 'UNKNOWN_RETRY_NEEDED':
        return this._handleUncertainVenueCancel(input, instrumentId, outcome.reason ?? 'unknown', 'UNKNOWN_RETRY_NEEDED');
    }
  }

  /**
   * Подтверждённая venue-отмена (CANCELLED/ALREADY_CANCELLED) → локальный commit.
   *
   * @param input - Входные данные
   * @param order - Свежий (non-terminal) Order
   * @param expectedVersion - Версия для CAS save
   * @param instrumentId - InstrumentId ордера
   * @param venueStatus - Подтверждённый venue-статус
   * @returns Ok(CancelOrderOutcome)
   *
   * @remarks
   * `order.cancel()` → CAS save → enqueue events (cancel committed) →
   * Portfolio release → journal release (ТОЛЬКО после успешного Portfolio
   * release) → CANCELLED/ALREADY_CANCELLED.
   *
   * ### Синхронизация Portfolio и journal (Этап 5.1):
   * - Portfolio release упал → journal НЕ освобождается (недопустимо состояние
   *   `Portfolio held + journal SETTLED`), помечается RECONCILIATION_REQUIRED,
   *   ставится instrument-block, issue → исход `RECONCILIATION_REQUIRED`.
   * - Portfolio release успешен, journal release упал → issue + block →
   *   исход `RECONCILIATION_REQUIRED`.
   * - Только после ДВУХ успешных операций возвращается CANCELLED/ALREADY_CANCELLED.
   *
   * Если venue подтвердил, но local CAS упал (не по причине concurrent
   * terminal) — НЕ release вслепую, `VENUE_LOCAL_ORDER_DESYNC`,
   * `RECONCILIATION_REQUIRED`, событий НЕ публикуем.
   */
  private async _commitConfirmedCancel(
    input: CancelOrderInput,
    order: Order,
    expectedVersion: number,
    instrumentId: ReturnType<typeof assetIdToInstrumentId>,
    venueStatus: 'CANCELLED' | 'ALREADY_CANCELLED',
  ): Promise<Result<CancelOrderOutcome, TradingError>> {
    const cancelResult = order.cancel(input.reason);
    if (!cancelResult.ok) {
      // Venue УЖЕ отменил ордер, а локальный domain-переход не удался: local
      // Order останется OPEN при мёртвом venue-ордере, резервация held. Это
      // partial commit — ставим manual block + issue, иначе последующие
      // операции инструмента ничем не блокируются (issue сама не блокирует).
      this._logger.error('Failed to cancel order locally after venue confirmed cancel — manual reconciliation required', {
        orderId: String(input.orderId),
        status: order.status,
        error: cancelResult.error.message,
      });
      this._markReconciliationBlock(input, instrumentId, `VENUE_CANCELLED_LOCAL_CANCEL_FAILED: ${cancelResult.error.message}`);
      await this._addReconciliationIssue({
        id: `reconciliation:cancel:${String(input.orderId)}:venue-cancelled-local-cancel-failed`,
        type: 'VENUE_LOCAL_ORDER_DESYNC',
        status: 'OPEN',
        reason: `VENUE_CANCELLED_LOCAL_CANCEL_FAILED: ${cancelResult.error.message}`,
        createdAt: this._deps.clock?.now() ?? new Date(),
        orderId: input.orderId,
        accountId: input.accountId,
        ...(instrumentId ? { instrumentId } : {}),
        context: { stage: 'venue-confirmed-cancel-local-cancel-failed', venueStatus, localStatus: order.status },
      });
      return Err(new TradingError(
        `Failed to cancel order: ${cancelResult.error.message}`,
        { context: { orderId: String(input.orderId), status: order.status } },
      ));
    }
    const cancelledOrder = cancelResult.value;

    const saveResult = await this._deps.orderRepo.save(cancelledOrder, expectedVersion);
    if (!saveResult.ok) {
      const latest = await this._deps.orderRepo.get(input.orderId);
      if (!latest) {
        // Ордер исчез (cleanup terminal) — считаем отменённым, резервация уже обработана.
        this._logger.warn('Order disappeared before cancel save — treating as already cancelled', {
          orderId: String(input.orderId),
        });
        return Ok({ status: 'ALREADY_CANCELLED' });
      }
      if (latest.isTerminal) {
        // Конкурирующий fill/cancel довёл до terminal — резервация обработана той
        // мутацией. Venue подтвердил cancel, но локально уже terminal → no-op
        // (с различением реального terminal-статуса, Шаг 6).
        this._logger.info('Order reached terminal state concurrently during cancel — no-op', {
          orderId: String(input.orderId),
          status: latest.status,
        });
        return Ok(this._terminalOutcome(latest.status));
      }
      // Venue подтвердил отмену, но локально не смогли зафиксировать (genuine
      // non-terminal conflict): НЕ release вслепую, desync issue, reconciliation.
      // Manual block обязателен: venue-ордер уже отменён, local Order остаётся
      // OPEN, резервация held — без блока последующие торговые операции
      // инструмента ничем не ограничены (issue сама не блокирует).
      this._logger.error('VENUE_LOCAL_ORDER_DESYNC: venue confirmed cancel but local CAS save conflicted (non-terminal) — reservation held', {
        orderId: String(input.orderId),
        expected: saveResult.error.expected,
        actual: saveResult.error.actual,
        latestStatus: latest.status,
      });
      this._markReconciliationBlock(input, instrumentId, `VENUE_CANCELLED_LOCAL_SAVE_CONFLICT: ${saveResult.error.message}`);
      await this._addReconciliationIssue({
        id: `reconciliation:cancel:${String(input.orderId)}:venue-cancelled-local-save-conflict`,
        type: 'VENUE_LOCAL_ORDER_DESYNC',
        status: 'OPEN',
        reason: `VENUE_CANCELLED_LOCAL_SAVE_CONFLICT: ${saveResult.error.message}`,
        createdAt: this._deps.clock?.now() ?? new Date(),
        orderId: input.orderId,
        accountId: input.accountId,
        ...(instrumentId ? { instrumentId } : {}),
        context: { stage: 'venue-confirmed-cancel-local-save-conflict', venueStatus, latestStatus: latest.status },
      });
      return Ok({ status: 'RECONCILIATION_REQUIRED', reason: `venue cancelled but local save conflict: ${saveResult.error.message}` });
    }

    // ENQUEUE cancel-события под lock СРАЗУ после committed CAS save (business
    // cancel состоялся независимо от исхода release ниже; flush — после lock в
    // execute()). Сбой enqueue НЕ откатывает cancel — helper логирует
    // EVENT_PUBLISH_FAILED и создаёт issue (Этап 5.2/8).
    const events = cancelledOrder.pullEvents();
    await enqueueCommittedEvents({
      outbox: this._deps.orderedEventOutbox,
      logger: this._logger,
      reconciliationIssues: this._deps.reconciliationIssues,
      now: this._deps.clock?.now() ?? new Date(),
      aggregateId: String(input.orderId),
      events: events as readonly unknown[],
      issueContext: {
        issueId: `reconciliation:cancel:${String(input.orderId)}:outbox-enqueue-failed`,
        stage: 'outbox-enqueue',
        orderId: input.orderId,
        accountId: input.accountId,
        ...(instrumentId ? { instrumentId } : {}),
        extra: { venueStatus },
      },
    });

    // CAS save committed → release оставшейся резервации (venue-ордер точно снят).
    const releaseResult = this._deps.portfolioService.releaseOrderReservation(input.accountId, cancelledOrder);
    if (!releaseResult.ok) {
      // Portfolio release упал → journal НЕ освобождаем (недопустимо
      // `Portfolio held + journal SETTLED`), помечаем RECONCILIATION_REQUIRED,
      // ставим instrument-block, issue → исход RECONCILIATION_REQUIRED.
      this._logger.error('CANCEL_RESERVATION_RELEASE_FAILED: reservation release failed after committed cancel — reservation may stay frozen', {
        orderId: String(input.orderId),
        error: releaseResult.error.message,
      });
      await this._markJournalReconciliationRequired(input.orderId, 'cancel-release-failed');
      this._markReconciliationBlock(input, instrumentId, `CANCEL_RESERVATION_RELEASE_FAILED: ${releaseResult.error.message}`);
      await this._addReconciliationIssue({
        id: `reconciliation:cancel:${String(input.orderId)}:reservation-release-failed`,
        type: 'ORDER_PORTFOLIO_DESYNC',
        status: 'OPEN',
        reason: `CANCEL_RESERVATION_RELEASE_FAILED: ${releaseResult.error.message}`,
        createdAt: this._deps.clock?.now() ?? new Date(),
        orderId: input.orderId,
        accountId: input.accountId,
        ...(instrumentId ? { instrumentId } : {}),
        context: { stage: 'cancel-release-reservation-after-order-save', localStatus: 'CANCELED' },
      });
      return Ok({
        status: 'RECONCILIATION_REQUIRED',
        reason: `cancel committed but Portfolio release failed: ${releaseResult.error.message}`,
      });
    }

    // Portfolio release подтверждён → journal release остатка (Result проверяется).
    const journalRelease = await this._releaseJournalReservation(input.orderId);
    if (!journalRelease.ok) {
      // Journal остался НЕ settled при уже освобождённом Portfolio — САМЫЙ
      // опасный desync (задержанный fill выбрал бы held-path на чужой капитал):
      // best-effort переводим journal в RECONCILIATION_REQUIRED + manual block.
      await this._markJournalReconciliationRequired(input.orderId, 'cancel-journal-release-failed');
      this._markReconciliationBlock(input, instrumentId, `CANCEL_JOURNAL_RELEASE_FAILED: ${journalRelease.error}`);
      await this._addReconciliationIssue({
        id: `reconciliation:cancel:${String(input.orderId)}:journal-release-failed`,
        type: 'RESERVATION_JOURNAL_DESYNC',
        status: 'OPEN',
        reason: `CANCEL_JOURNAL_RELEASE_FAILED: ${journalRelease.error}`,
        createdAt: this._deps.clock?.now() ?? new Date(),
        orderId: input.orderId,
        accountId: input.accountId,
        ...(instrumentId ? { instrumentId } : {}),
        context: { stage: 'cancel-journal-release-after-portfolio-release', localStatus: 'CANCELED' },
      });
      return Ok({
        status: 'RECONCILIATION_REQUIRED',
        reason: `cancel committed but reservation journal release failed: ${journalRelease.error}`,
      });
    }

    this._logger.info('Order cancelled successfully (venue confirmed)', {
      orderId: String(input.orderId),
      venueStatus,
      reason: input.reason ?? 'User cancelled',
    });
    return Ok({ status: venueStatus === 'ALREADY_CANCELLED' ? 'ALREADY_CANCELLED' : 'CANCELLED' });
  }

  /**
   * Ставит typed manual reconciliation block при частичном commit cancel-а.
   *
   * @param input - Входные данные (orderId)
   * @param instrumentId - InstrumentId ордера
   * @param reason - Причина блока (English, для оператора)
   *
   * @remarks
   * Замороженная резервация / рассинхрон Portfolio↔journal должны блокировать
   * новые торговые операции на инструменте (`hasUnsettledFills`) до ручной
   * реконсиляции — инвариант «частично закоммиченное состояние блокирует торговлю».
   * Используется ИМЕННО manual block (не MATCHED placeholder): placeholder
   * снимается первым реальным fill-ом, а этот блок обязан пережить fill —
   * задержанный fill на desync-ордере сам блокируется guard'ом ProcessFillUseCase
   * и НЕ должен «разрешать» состояние.
   */
  private _markReconciliationBlock(
    input: CancelOrderInput,
    instrumentId: ReturnType<typeof assetIdToInstrumentId>,
    reason: string,
  ): void {
    if (!instrumentId) return;
    this._deps.orderStateStore.markManualReconciliationBlock({
      orderId: input.orderId,
      instrumentId,
      reason,
    });
  }

  /**
   * Venue вернул ALREADY_FILLED — ордер matched, НЕ отменяем локально.
   *
   * @param input - Входные данные
   * @param instrumentId - InstrumentId ордера
   * @param reason - Причина от venue
   * @returns Ok({ status: 'FILL_PENDING' })
   *
   * @remarks
   * Локальный Order НЕ переводим в CANCELED, резервацию НЕ освобождаем: ждём Fill,
   * который позже пройдёт normal path и потребит резервацию ровно один раз.
   * Ставим matched (order-level) + instrument-block до прихода Fill.
   */
  private _handleAlreadyFilled(
    input: CancelOrderInput,
    instrumentId: ReturnType<typeof assetIdToInstrumentId>,
    reason: string | undefined,
  ): Result<CancelOrderOutcome, TradingError> {
    const pendingFillId = pendingMatchFillId(input.orderId);
    this._deps.orderStateStore.markOrderFillMatched(input.orderId, pendingFillId);
    if (instrumentId) {
      this._deps.orderStateStore.markInFlightFill({
        instrumentId,
        fillId: pendingFillId,
        orderId: input.orderId,
        status: 'MATCHED',
      });
    }
    this._logger.warn('Cancel rejected — order matched on venue; local order NOT cancelled, reservation held, awaiting fill', {
      orderId: String(input.orderId),
      reason,
    });
    return Ok({ status: 'FILL_PENDING' });
  }

  /**
   * Неоднозначный venue-исход (NOT_FOUND/UNKNOWN_RETRY_NEEDED/transport/throw).
   *
   * @param input - Входные данные
   * @param instrumentId - InstrumentId ордера
   * @param reason - Причина
   * @param outcome - Классификация исхода (для issue/логов)
   * @returns Ok({ status: 'RECONCILIATION_REQUIRED', reason })
   *
   * @remarks
   * НЕ подтверждение отмены: локально НЕ меняем (Order остаётся как есть),
   * резервация held. Ставим instrument-block (новые ордера того же инструмента
   * блокируются, пока venue-состояние неизвестно) + `CANCEL_UNKNOWN_OUTCOME` issue.
   */
  private async _handleUncertainVenueCancel(
    input: CancelOrderInput,
    instrumentId: ReturnType<typeof assetIdToInstrumentId>,
    reason: string,
    outcome: UncertainOutcome,
  ): Promise<Result<CancelOrderOutcome, TradingError>> {
    // Instrument-block: блокируем новые ордера, пока venue-судьба неизвестна.
    if (instrumentId) {
      this._deps.orderStateStore.markInFlightFill({
        instrumentId,
        fillId: pendingMatchFillId(input.orderId),
        orderId: input.orderId,
        status: 'MATCHED',
      });
    }
    const slug = outcome === 'NOT_FOUND' ? 'not-found'
      : outcome === 'UNKNOWN_RETRY_NEEDED' ? 'unknown'
      : 'transport-error';
    await this._addReconciliationIssue({
      id: `reconciliation:cancel:${String(input.orderId)}:${slug}`,
      type: 'CANCEL_UNKNOWN_OUTCOME',
      status: 'OPEN',
      reason,
      createdAt: this._deps.clock?.now() ?? new Date(),
      orderId: input.orderId,
      accountId: input.accountId,
      ...(instrumentId ? { instrumentId } : {}),
      context: {
        stage: 'venue-cancel-uncertain-outcome',
        outcome,
        localStatus: 'UNCHANGED',
        reservationHeld: true,
      },
    });
    return Ok({ status: 'RECONCILIATION_REQUIRED', reason: `${outcome}: ${reason}` });
  }

  /**
   * Освобождает остаток резервации в execution journal при подтверждённой отмене.
   *
   * @param venueOrderId - venue orderId (для обратного поиска записи)
   * @returns `{ ok: true }` при успехе (в т.ч. записи/остатка нет);
   *   `{ ok: false, error }` при сбое transition — caller ОБЯЗАН вернуть
   *   `RECONCILIATION_REQUIRED` и сохранить block/issue
   *
   * @remarks
   * COMMIT-CRITICAL (Этап 5.1): вызывается ТОЛЬКО после успешного Portfolio
   * release. operationId attempt-scoped (`attempt:${attempt}:cancel-release`) —
   * идемпотентно в рамках попытки, операции разных попыток не считаются
   * дубликатами.
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
        operationId: `attempt:${record.attempt}:cancel-release`,
        release: remaining.toString(),
        now: this._deps.clock?.now() ?? new Date(),
      });
      if (!r.ok) {
        this._logger.error('Reservation journal release failed on confirmed cancel', {
          venueOrderId: String(venueOrderId),
          error: r.error.message,
        });
        return { ok: false, error: r.error.message };
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('Reservation journal release threw on confirmed cancel', {
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
   * Используется, когда Portfolio release упал: journal НЕЛЬЗЯ переводить в
   * SETTLED (капитал может остаться замороженным). Сбой самой пометки
   * логируется (journal и так не SETTLED — блок обеспечен marker'ом/issue).
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
        this._logger.error('Failed to mark reservation journal RECONCILIATION_REQUIRED on cancel', {
          venueOrderId: String(venueOrderId),
          error: r.error.message,
        });
      }
    } catch (err) {
      this._logger.error('Failed to mark reservation journal RECONCILIATION_REQUIRED on cancel (threw)', {
        venueOrderId: String(venueOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
