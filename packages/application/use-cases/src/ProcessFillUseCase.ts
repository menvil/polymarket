/**
 * ProcessFillUseCase — оркестрация обработки исполнения ордера (Fill).
 *
 * @remarks
 * ### Алгоритм:
 * 1. Idempotency guard (`IProcessedFillRepository.begin`) — `DUPLICATE`/`BUSY`
 *    возвращают Ok без повторной обработки; `RECONCILIATION_REQUIRED` тоже
 *    возвращает Ok (no-op), но с error-логом — retry не разрешён (см. п.6);
 *    `ACQUIRED` обязывает довести обработку до `markApplied()`, `markFailed()`
 *    либо `markReconciliationRequired()`.
 * 2. Keyed mutex (`IKeyedMutex.runExclusive`) по [accountId, orderId, instrumentId] —
 *    сериализует эту обработку относительно `CancelOrderUseCase` и других
 *    конкурентных fill-ов того же ордера/инструмента.
 * 3. Получение Order из репозитория
 *    — если ордер не найден или уже terminal (CANCELLED/FILLED): direct fill path.
 *    Portfolio обновляется немедленно через applyDirectFill (без резерваций).
 * 4. Применение Fill к Order (sync, order.applyFill)
 * 5. Синхронное сохранение обновлённого Order (orderStateStore.saveSync)
 * 6. Обновление Portfolio (PortfolioService.applyFill) — если упадёт ПОСЛЕ шага 5
 *    (Order уже сохранён), это `markReconciliationRequired()` (терминально,
 *    retry НЕ разрешён), а не `markFailed()`: Order.applyFill defends against
 *    duplicate fill id, поэтому retry такого fillId лишь повторит "duplicate
 *    fill" и никогда не восстановит Portfolio (`ORDER_PORTFOLIO_DESYNC` в
 *    логах, ручная реконсиляция). Если в deps передан `reconciliationIssues`,
 *    дополнительно создаётся queryable `ReconciliationIssue`
 *    (type `ORDER_PORTFOLIO_DESYNC`, детерминированный id) — best-effort:
 *    сбой `add()` логируется и не меняет исходный error path.
 * 7. Запись в Ledger (LedgerService.recordFill). Если `recordFill` бросит ПОСЛЕ
 *    commit Order+Portfolio — это частичный commit (Ledger отстаёт), retry
 *    бесполезен (Order defends против duplicate fill id; direct-path повторно
 *    применил бы Portfolio) → `markReconciliationRequired()`
 *    (`ORDER_PORTFOLIO_LEDGER_DESYNC`) + reconciliation issue, Err.
 * 8. `markApplied(fill.id)` — сразу после успешного завершения шагов 4–7 (commit
 *    состояния Order/Portfolio/Ledger), ДО публикации событий.
 * 9. Публикация доменных событий Order (await) — НЕ гейтит markApplied и НЕ
 *    меняет результат: notification path, не транзакция. Если публикация
 *    упадёт, fill уже `APPLIED` и retry невозможен: состояние уже закоммичено,
 *    повторный вызов лишь заново применил бы уже применённый fill (Order
 *    defends against duplicate fill id, но direct-fill path и Portfolio — нет),
 *    удвоив эффект. Ошибка публикации логируется отдельно
 *    (`EVENT_PUBLISH_FAILED`) как потеря уведомления, требующая ручного replay,
 *    и `execute()` возвращает Ok — Err делал бы committed fill похожим на
 *    retryable business failure.
 *    Любая ошибка на шаге 4 (order.applyFill, до saveSync) → `markFailed(fill.id, reason)`,
 *    fillId остаётся retryable. Ошибка на шаге 6 ПОСЛЕ saveSync →
 *    `markReconciliationRequired()` (см. п.6), НЕ retryable FAILED.
 *
 * ### Идемпотентность:
 * Повторный вызов с тем же fillId, пока предыдущая попытка ещё не завершилась
 * (`PROCESSING`) — `BUSY`, Ok без повторной обработки. После `APPLIED` — `DUPLICATE`,
 * Ok без повторной обработки. После `FAILED`/`REVERTED` — retry разрешён.
 * После `RECONCILIATION_REQUIRED` — retry НЕ разрешён: `execute()` возвращает
 * Ok (no-op) при каждом повторном вызове, но логирует error — fill не мутирует
 * Order/Portfolio/Ledger повторно, требуется ручная реконсиляция.
 *
 * ### Консистентность (устранение race condition):
 * Шаги 4–7 выполняются синхронно, без yield между ними.
 * `await` появляется только на шаге 8 (publishAll) и на idempotency/mutex вызовах.
 * К моменту первого yield внутри критической секции ордер уже помечен как
 * terminal (FILED/CANCELLED), поэтому любой тик стратегии или CancelOrderUseCase,
 * запущенный в этом окне, увидит `order.isTerminal === true` и пропустит отмену:
 * ```
 * // CancelOrderUseCase, строка 100:
 * if (order.isTerminal) return Ok(undefined);  // no-op
 * ```
 * Это устраняет ошибку «Cannot unfreeze/consume X: only 0 reserved».
 * Keyed mutex (шаг 2) устраняет ту же гонку и на уровне межпроцессного тика —
 * `CancelOrderUseCase.execute()` для того же orderId дожидается завершения
 * этой обработки, а не читает Order в промежуточном состоянии.
 *
 * @example
 * ```typescript
 * const useCase = new ProcessFillUseCase({
 *   orderStateStore, portfolioService, ledgerService,
 *   processedFillRepo, orderRepo, keyedMutex, eventBus, logger,
 * });
 *
 * const result = await useCase.execute(fill);
 * if (!result.ok) logger.error('Fill processing failed', { error: result.error.message });
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type {
  IOrderRepository,
  IProcessedFillRepository,
  IOrderStateStore,
  IKeyedMutex,
  IOrderedEventOutbox,
  IReconciliationIssueRepository,
  IOrderSubmissionRepository,
  OrderSubmissionRecord,
} from '@polymarket/ports';
import type { IEventBus, ApplicationEvent } from '@polymarket/event-bus';
import type { Fill } from '@polymarket/fill';
import type { FillData, Order } from '@polymarket/order';
import Decimal from 'decimal.js';
import { assetIdToInstrumentId, accountIdToString } from '@polymarket/ids';
import { pendingMatchFillId, canConsumeHeldReservation } from '@polymarket/ports';
import type { PortfolioService } from './services/PortfolioService.js';
import type { LedgerService } from './services/LedgerService.js';
import { enqueueCommittedEvents } from './services/enqueueCommittedEvents.js';
import { lockKey } from './lockKeys.js';

/** Зависимости ProcessFillUseCase */
export interface ProcessFillDeps {
  readonly orderStateStore: IOrderStateStore;
  readonly portfolioService: PortfolioService;
  readonly ledgerService: LedgerService;
  readonly orderRepo: IOrderRepository;
  readonly processedFillRepo: IProcessedFillRepository;
  readonly keyedMutex: IKeyedMutex;
  readonly eventBus: IEventBus;
  /**
   * Submission guard + reservation journal.
   *
   * @remarks
   * `findByVenueOrderId(fill.orderId)` находит execution journal по venueOrderId
   * (fill приходит с venueOrderId). Если локального Order нет/он terminal, но есть
   * held-резервация — Fill потребляет её (recovery-путь), а не дебетует available
   * второй раз. `applyReservationTransition` синхронизирует учёт (consume/release,
   * идемпотентно по fillId) и для normal, и для held-recovery путей.
   */
  readonly submissions: IOrderSubmissionRepository;
  /**
   * Ordered event outbox для доменных событий Order lifecycle (ORDER_FILLED и т.д.).
   *
   * @remarks
   * Fill-события того же ордера enqueue-ятся с `aggregateId=orderId`, что
   * сохраняет per-order порядок относительно Place-событий (Fill не опубликует
   * ORDER_FILLED раньше ORDER_CREATED/ORDER_ACCEPTED). Публикация (flush) — ПОСЛЕ
   * выхода из keyed mutex, что исключает deadlock. Direct-fill события
   * (DIRECT_FILL_APPLIED) публикуются напрямую через eventBus — они не относятся
   * к live Order aggregate (ордер terminal/не найден).
   */
  readonly orderedEventOutbox: IOrderedEventOutbox;
  readonly logger: ILogger;
  /**
   * Queryable хранилище reconciliation issues (опционально).
   *
   * @remarks
   * Optional — чтобы не ломать существующие конструкторы/тесты: без него
   * поведение прежнее (markReconciliationRequired + logging). Если передан,
   * `RECONCILIATION_REQUIRED` дополнительно создаёт `ReconciliationIssue`
   * с детерминированным id (idempotent add). Сбой `add()` НЕ маскирует
   * исходную trading-ошибку — только error-лог.
   */
  readonly reconciliationIssues?: IReconciliationIssueRepository;
  /**
   * Источник времени для `ReconciliationIssue.createdAt` (опционально).
   *
   * @remarks
   * Optional по той же причине, что и `reconciliationIssues`. Если не передан,
   * используется `new Date()` (только для createdAt issue — trading flow
   * времени не использует).
   */
  readonly clock?: IClock;
}

/**
 * Use case обработки Fill исполнения.
 *
 * @remarks
 * Оркестрирует идемпотентное обновление Order, Portfolio и Ledger
 * при получении нового исполнения ордера.
 * Все state-мутации выполняются синхронно до первого await внутри критической секции.
 */
export class ProcessFillUseCase {
  private readonly _logger: ILogger;

  /**
   * @param deps - Зависимости use case
   */
  constructor(private readonly _deps: ProcessFillDeps) {
    this._logger = _deps.logger.child({ component: 'ProcessFillUseCase' });
  }

  /**
   * Выполняет обработку исполнения ордера.
   *
   * @param fill - Полученное исполнение ордера
   * @returns Ok(void) при успехе (в т.ч. duplicate/busy/reconciliation-required — no-op),
   *   Err(TradingError) при ошибке обработки
   *
   * @remarks
   * Повторный вызов с тем же fill.id безопасен: `DUPLICATE` (уже применён) или
   * `BUSY` (обрабатывается конкурентно) возвращают Ok без повторной обработки.
   * После `FAILED`/`REVERTED` — retry разрешён. После `RECONCILIATION_REQUIRED` —
   * retry НЕ разрешён (частичный commit, нужна ручная реконсиляция): возвращает
   * Ok (no-op, fill не мутируется повторно), но логирует error при каждом
   * вызове, чтобы не молчать о нерешённой проблеме.
   */
  public async execute(fill: Fill): Promise<Result<void, TradingError>> {
    // Шаг 1: Idempotency guard
    const begin = await this._deps.processedFillRepo.begin(fill.id);
    if (begin.outcome === 'DUPLICATE') {
      this._logger.debug('Fill already applied, skipping (idempotent)', { fillId: String(fill.id) });
      return Ok(undefined);
    }
    if (begin.outcome === 'BUSY') {
      this._logger.warn('Fill already being processed concurrently, skipping', { fillId: String(fill.id) });
      return Ok(undefined);
    }
    if (begin.outcome === 'RECONCILIATION_REQUIRED') {
      // Терминально — НЕ ACQUIRED, значит НЕ мутируем Order/Portfolio/Ledger
      // повторно. Ok (no-op), а не Err: caller (WS handler / ReconcileTradesUseCase)
      // не должен трактовать это как retryable ошибку. Error-лог на каждый
      // вызов — чтобы нерешённая проблема оставалась видимой в мониторинге.
      this._logger.error('ORDER_PORTFOLIO_DESYNC: fill requires manual reconciliation — retry not attempted, skipping', {
        fillId: String(fill.id),
      });
      return Ok(undefined);
    }
    if (begin.isRetry) {
      this._logger.info('Retrying previously failed/reverted fill', { fillId: String(fill.id) });
    }

    // Шаг 2: Keyed mutex — сериализует относительно CancelOrderUseCase и других
    // конкурентных fill-ов того же ордера/инструмента/аккаунта.
    // Namespaced keys (lockKey.*) — пересечение с Place ([account,instrument]),
    // Cancel/Update ([account,order,...]) по общим сущностям.
    const instrumentId = assetIdToInstrumentId(fill.tokenId);
    const lockKeys = [
      lockKey.account(fill.accountId),
      lockKey.order(fill.orderId),
      lockKey.instrument(instrumentId ? String(instrumentId) : String(fill.tokenId)),
    ];

    const result = await this._deps.keyedMutex.runExclusive(lockKeys, () => this._processLocked(fill));
    // flush() ВНЕ lock: публикует enqueued Order-события (никогда не бросает).
    await this._deps.orderedEventOutbox.flush();
    return result;
  }

  /**
   * Тело обработки fill — вызывается ВНУТРИ keyed mutex.
   *
   * @param fill - Полученное исполнение ордера
   * @returns Ok(void) при успехе, Err(TradingError) при ошибке
   *
   * @remarks
   * Выбор из трёх путей по состоянию Order + reservation journal:
   * 1. **Normal** — есть живой (non-terminal) локальный Order:
   *    `order.applyFill` + Portfolio consume reserved + journal consume.
   * 2. **Held-reservation recovery** — Order нет/terminal, НО execution journal
   *    имеет held-резервацию (ambiguous submit без local Order): потребляем
   *    held-резервацию (`applyFillAgainstHeldReservation`), а НЕ дебетуем available.
   * 3. **External/released direct** — ни живого Order, ни held-резервации:
   *    `applyDirectFill` из available (внешний/уже освобождённый ордер).
   *
   * Инвариант: каждый Fill использует ровно ОДИН источник (held reservation ЛИБО
   * available) — никогда одновременно списание available и оставленную held-резервацию.
   */
  private async _processLocked(fill: Fill): Promise<Result<void, TradingError>> {
    // Stage 6: application-level processing-блок (PROCESSING) на весь период
    // обработки. Снимается ТОЛЬКО на реально settled (markApplied); на
    // retryable/reconciliation остаётся (FAILED_RETRYABLE/RECONCILIATION_REQUIRED)
    // и блокирует новую активность через hasUnsettledFills(instrumentId).
    const procInstrumentId = assetIdToInstrumentId(fill.tokenId);
    if (procInstrumentId) {
      this._deps.orderStateStore.markFillProcessing({
        fillId: fill.id,
        orderId: fill.orderId,
        instrumentId: procInstrumentId,
      });
    }

    // Manual reconciliation block (по order ИЛИ instrument) блокирует ЛЮБОЙ путь
    // ДО каких-либо мутаций и ДО чтения Order/journal: частично закоммиченное
    // состояние (например, journal остался HELD после успешного Portfolio
    // release) разрешает ТОЛЬКО человек. Реальный Fill manual block НЕ снимает
    // (в отличие от MATCHED placeholder) — иначе задержанный fill на
    // desync-ордере потребил бы чужой reserved-капитал и замёл бы блок.
    const manualBlockedByOrder = this._deps.orderStateStore.hasManualReconciliationBlockForOrder(fill.orderId);
    const manualBlockedByInstrument = procInstrumentId
      ? this._deps.orderStateStore.hasManualReconciliationBlocks(procInstrumentId)
      : false;
    if (manualBlockedByOrder || manualBlockedByInstrument) {
      const blocks = procInstrumentId
        ? this._deps.orderStateStore.getManualReconciliationBlocks(procInstrumentId)
        : [];
      return this._blockFillOnReconciliation(fill, {
        idSuffix: 'manual-reconciliation-block',
        reason: 'MANUAL_RECONCILIATION_BLOCK: order/instrument is under manual reconciliation block',
        stage: 'manual-reconciliation-block-guard',
        error: manualBlockedByOrder
          ? `manual block set for orderId ${String(fill.orderId)}`
          : `manual block(s) on instrument: ${blocks.map((b) => String(b.orderId)).join(',')}`,
        extraContext: {
          blockedByOrder: manualBlockedByOrder,
          blockedByInstrument: manualBlockedByInstrument,
        },
      });
    }

    // Order (по venueOrderId) + execution journal (обратный поиск по venueOrderId).
    const order = await this._deps.orderRepo.get(fill.orderId);
    const execution = await this._deps.submissions.findByVenueOrderId(fill.orderId);

    // Reservation RECONCILIATION_REQUIRED блокирует ЛЮБОЙ путь (normal/held/
    // direct) ДО каких-либо мутаций: учёт резервации неоднозначен, применение
    // fill поверх него углубило бы desync. Fill фиксируется reconciliation-блоком
    // до ручной реконсиляции.
    if (execution && execution.reservation.status === 'RECONCILIATION_REQUIRED') {
      return this._blockFillOnReconciliation(fill, {
        idSuffix: 'reservation-reconciliation-required',
        reason: 'RESERVATION_RECONCILIATION_REQUIRED: execution journal reservation is in RECONCILIATION_REQUIRED state',
        stage: 'reservation-status-guard',
        error: `reservation status=${execution.reservation.status} remaining=${execution.reservation.remaining}`,
        extraContext: {
          clientOrderId: String(execution.clientOrderId),
          reservationStatus: execution.reservation.status,
          reservationRemaining: execution.reservation.remaining,
        },
      });
    }

    if (order && !order.isTerminal) {
      return this._applyNormalFill(order, fill, execution);
    }
    // Held-reservation проверяется и для отсутствующего, и для terminal Order:
    // ambiguous submit мог не сохранить Order, но капитал заморожен.
    // canConsumeHeldReservation: ТОЛЬКО HELD/PARTIALLY_SETTLED с remaining > 0 —
    // RECONCILIATION_REQUIRED отсеян guard'ом выше и НИКОГДА не потребляется
    // автоматически.
    if (execution && canConsumeHeldReservation(execution.reservation)) {
      return this._applyHeldReservationFill(fill, execution);
    }
    return this._applyDirectFill(fill);
  }

  /**
   * Блокирует fill reconciliation-блоком БЕЗ каких-либо мутаций Portfolio/Ledger/journal.
   *
   * @param fill - Блокируемый fill
   * @param params - Параметры issue (см. `_addReconciliationIssue`)
   * @returns Err(TradingError) — fill требует ручной реконсиляции
   *
   * @remarks
   * Используется guard'ами ДО мутаций (reservation RECONCILIATION_REQUIRED,
   * провал prevalidation held-fill): processed fill → RECONCILIATION_REQUIRED
   * (retry запрещён), instrument processing-блок сохраняется (`hasUnsettledFills`
   * остаётся true), создаётся queryable issue с фактическими значениями.
   */
  private async _blockFillOnReconciliation(
    fill: Fill,
    params: {
      readonly idSuffix: string;
      readonly reason: string;
      readonly stage: string;
      readonly error: string;
      readonly extraContext?: Readonly<Record<string, string | number | boolean | null>>;
      readonly issueType?: 'ORDER_PORTFOLIO_DESYNC' | 'RESERVATION_JOURNAL_DESYNC';
    },
  ): Promise<Result<void, TradingError>> {
    this._logger.error(`${params.reason} — fill blocked, manual reconciliation required`, {
      fillId: String(fill.id),
      orderId: String(fill.orderId),
      stage: params.stage,
      error: params.error,
    });
    this._clearInFlightFlags(fill);
    this._deps.orderStateStore.updateFillProcessingStatus(fill.id, 'RECONCILIATION_REQUIRED');
    await this._deps.processedFillRepo.markReconciliationRequired(fill.id, params.reason);
    await this._addReconciliationIssue(fill, params);
    return Err(new TradingError(
      `Fill blocked pending manual reconciliation: ${params.reason}`,
      { context: { fillId: String(fill.id), orderId: String(fill.orderId), stage: params.stage } },
    ));
  }

  /**
   * External/released direct-fill path — fill на terminal/не найденный ордер БЕЗ
   * held-резервации. Списывает из available (`applyDirectFill`).
   *
   * @param fill - Исполнение ордера
   * @returns Ok(void) при успехе, Err при ошибке
   */
  private async _applyDirectFill(fill: Fill): Promise<Result<void, TradingError>> {
    const order = await this._deps.orderRepo.get(fill.orderId);
    {
      const reason = !order ? 'not found' : `terminal (${order.status})`;
      this._logger.warn('Fill arrived for order that is ' + reason + ' — applying direct fill', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        side: fill.side,
        size: fill.size.toNumber(),
        price: fill.price.toNumber(),
      });

      const directResult = this._deps.portfolioService.applyDirectFill(fill);
      if (!directResult.ok) {
        this._logger.error('Direct fill portfolio update failed', {
          fillId: String(fill.id),
          orderId: String(fill.orderId),
          error: directResult.error.message,
        });
        this._clearInFlightFlags(fill);
        this._deps.orderStateStore.updateFillProcessingStatus(fill.id, 'FAILED_RETRYABLE');
        await this._deps.processedFillRepo.markFailed(fill.id, directResult.error.message);
        return Err(new TradingError(
          `Direct fill portfolio update failed: ${directResult.error.message}`,
          { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
        ));
      }

      // Запись в Ledger. Portfolio уже применён (applyDirectFill выше) —
      // если recordFill бросит, retry этого fillId повторно применил бы
      // Portfolio (direct-path не защищён от duplicate, в отличие от
      // Order.applyFill) → RECONCILIATION_REQUIRED (терминально), НЕ markFailed.
      try {
        this._deps.ledgerService.recordFill(fill);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = `ORDER_PORTFOLIO_LEDGER_DESYNC: ${message}`;
        this._logger.error('ORDER_PORTFOLIO_LEDGER_DESYNC: Ledger record failed after direct-fill Portfolio already committed — fill requires manual reconciliation', {
          fillId: String(fill.id),
          orderId: String(fill.orderId),
          error: message,
        });
        this._clearInFlightFlags(fill);
        this._deps.orderStateStore.updateFillProcessingStatus(fill.id, 'RECONCILIATION_REQUIRED');
        await this._deps.processedFillRepo.markReconciliationRequired(fill.id, reason);
        await this._addReconciliationIssue(fill, {
          idSuffix: 'order-portfolio-ledger-desync',
          reason,
          stage: 'ledger-record-after-direct-fill-portfolio-apply',
          error: message,
        });
        return Err(new TradingError(
          `Failed to record direct fill in ledger (Portfolio already committed — manual reconciliation required): ${message}`,
          { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
        ));
      }
      this._clearInFlightFlags(fill);

      // Диагностика fee для direct fill (BUY).
      // PortfolioService.applyDirectFill тоже вычтет feeInTokens из позиции.
      if (fill.side === 'BUY' && !fill.fee.isZero()) {
        const feeUSDC = fill.fee.quantity.amount().value();
        const fillPrice = fill.price.value();
        const feeInTokens = feeUSDC.div(fillPrice);
        this._logger.info('BUY direct fill fee deduction applied', {
          fillId: String(fill.id),
          grossTokens: fill.size.value().toNumber(),
          feeUSDC: feeUSDC.toNumber(),
          feeInTokens: feeInTokens.toNumber(),
          netTokens: fill.size.value().minus(feeInTokens).toNumber(),
        });
      }

      // Portfolio/Ledger уже применены (commit состоялся) — помечаем APPLIED
      // ДО попытки публикации. Публикация — это уведомление о свершившемся
      // факте, а не часть транзакции: если пометить fill FAILED из-за ошибки
      // publish, retry вызовет execute() заново, order всё ещё terminal/not-found
      // → снова direct-fill path → applyDirectFill() применится к Portfolio
      // ПОВТОРНО (нет defence от duplicate на этом пути, в отличие от
      // Order.applyFill) — двойной учёт баланса. Поэтому publish-ошибка не
      // должна делать fill retryable.
      this._deps.orderStateStore.clearFillProcessing(fill.id);
      await this._deps.processedFillRepo.markApplied(fill.id);

      // ENQUEUE DIRECT_FILL_APPLIED в ordered outbox с aggregateId=orderId (НЕ
      // direct-fill:${fill.id}) — сохраняет порядок относительно ORDER_CANCELLED/
      // ORDER_CREATED того же venue order. Публикация (flush) — ПОСЛЕ выхода из
      // lock (execute). MarketRotation учитывает fill в fillHistory.
      await this._enqueueEvents(fill, [{ type: 'DIRECT_FILL_APPLIED', fill } as ApplicationEvent]);

      return Ok(undefined);
    }
  }

  /**
   * Enqueue доменных событий fill в ordered outbox (aggregateId=orderId).
   *
   * @param fill - Fill (для aggregateId + контекста issue)
   * @param events - События для публикации
   *
   * @remarks
   * Делегирует общему helper'у `enqueueCommittedEvents`: сбой enqueue ПОСЛЕ
   * committed fill не делает fill retryable — логируется EVENT_PUBLISH_FAILED
   * и создаётся issue (stage `outbox-enqueue`). Никогда не бросает.
   */
  private async _enqueueEvents(fill: Fill, events: readonly ApplicationEvent[]): Promise<void> {
    const instrumentId = assetIdToInstrumentId(fill.tokenId);
    await enqueueCommittedEvents({
      outbox: this._deps.orderedEventOutbox,
      logger: this._logger,
      reconciliationIssues: this._deps.reconciliationIssues,
      now: this._deps.clock?.now() ?? new Date(),
      aggregateId: String(fill.orderId),
      events: events as readonly unknown[],
      issueContext: {
        issueId: `reconciliation:fill:${String(fill.id)}:outbox-enqueue-failed`,
        stage: 'outbox-enqueue',
        orderId: fill.orderId,
        fillId: fill.id,
        accountId: fill.accountId,
        ...(instrumentId ? { instrumentId } : {}),
      },
    });
  }

  /**
   * Normal fill path — живой локальный Order.
   *
   * @param order - Живой (non-terminal) Order
   * @param fill - Исполнение ордера
   * @param execution - execution journal (может отсутствовать для внешних Order)
   * @returns Ok(void) при успехе, Err при ошибке
   *
   * @remarks
   * `order.applyFill` → saveSync → Portfolio consume reserved → Ledger → journal
   * consume → dust release → markApplied. Journal consume синхронизирует учёт
   * (best-effort — Portfolio authoritative; сбой журнала логируется, но не делает
   * committed fill retryable), чтобы поздний terminal fill не выбрал ложно
   * held-путь.
   */
  private async _applyNormalFill(
    order: Order,
    fill: Fill,
    execution: OrderSubmissionRecord | undefined,
  ): Promise<Result<void, TradingError>> {
    // Шаги ниже выполняются синхронно (без yield) — атомарное обновление состояния.
    // Первый await появляется только на публикации событий.

    // Применить Fill к Order (sync)
    const fillData: FillData = {
      id: fill.id,
      orderId: fill.orderId,
      asset: fill.tokenId,
      side: fill.side,
      size: fill.size,
      price: fill.price,
    };
    const applyResult = order.applyFill(fillData);
    if (!applyResult.ok) {
      this._logger.warn('Failed to apply fill to order', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        error: applyResult.error.message,
      });
      // Снимаем флаги даже при ошибке — fill уже on-chain,
      // повторная пометка произойдёт при следующем fill-событии если нужно.
      this._clearInFlightFlags(fill);
      this._deps.orderStateStore.updateFillProcessingStatus(fill.id, 'FAILED_RETRYABLE');
      await this._deps.processedFillRepo.markFailed(fill.id, applyResult.error.message);
      return Err(new TradingError(
        `Failed to apply fill to order: ${applyResult.error.message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }
    const updatedOrder = applyResult.value;

    // Синхронно сохранить обновлённый Order (terminal = true, если FILLED)
    // После этой строки любой читатель IOrderStateStore увидит ордер как FILED/terminal.
    // CancelOrderUseCase: if (order.isTerminal) return Ok(undefined) — пропустит cancel.
    //
    // TODO(unit-of-work): replace this sequential commit with an explicit
    // UnitOfWork boundary for Order + Portfolio + Ledger + ProcessedFill.
    // Current behaviour is a compensating transaction: saveSync commits Order
    // first, then later steps either finish or mark RECONCILIATION_REQUIRED.
    // A real UoW should mutate snapshots and commit all affected stores in one
    // boundary: in-memory as a locked copy-swap, persistent storage as a DB
    // transaction/atomic batch. Until then this block is intentionally not
    // full atomicity; reconciliation issues are the recovery mechanism.
    // saveSync intentionally bypasses repository CAS to preserve current
    // no-yield fill/cancel race fix.
    // saveSync при этом ИНКРЕМЕНТИТ версию записи — конкурирующий CAS save
    // (CancelOrderUseCase/UpdateOrderStatusUseCase) со stale-версией корректно
    // получит VersionConflictError и не перетрёт применённый fill.
    this._deps.orderStateStore.saveSync(updatedOrder);

    // Обновить Portfolio (sync)
    // Передаём цену ордера, чтобы точно совпасть с зарезервированной суммой
    // (fill.price может быть округлена биржей: 0.829 → 0.83, что вызывает «Cannot unfreeze/consume»).
    this._logger.info('Applying fill to portfolio', {
      fillId: String(fill.id),
      orderId: String(fill.orderId),
      side: fill.side,
      fillPrice: fill.price.value().toNumber(),
      orderPrice: order.price.value().toNumber(),
      fillSize: fill.size.value().toNumber(),
      notional: order.price.value().times(fill.size.value()).toNumber(),
    });
    const portfolioResult = this._deps.portfolioService.applyFill(fill, order.price.value());
    if (!portfolioResult.ok) {
      // ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (нет полного Unit of Work — вне scope этого этапа):
      // Order уже сохранён ВЫШЕ (saveSync) с применённым fill.id, а Portfolio —
      // нет. Order.applyFill() защищён от повторного применения того же fillId
      // (см. Order._fill.ts), поэтому retry этого fillId НЕ приведёт к повторному
      // прогону Portfolio — он остановится на applyFill-to-order с ошибкой
      // "duplicate fill". Именно поэтому здесь `markReconciliationRequired()`,
      // а НЕ `markFailed()`: FAILED подразумевает «retry поможет», а тут retry
      // гарантированно бесполезен и лишь маскирует проблему повторяющейся
      // ошибкой "duplicate fill" вместо истинной причины.
      // RECONCILIATION_REQUIRED — терминальный статус: begin() больше НЕ выдаст
      // ACQUIRED для этого fillId, требуется явная ручная реконсиляция Order↔Portfolio.
      this._logger.error('ORDER_PORTFOLIO_DESYNC: Failed to apply fill to portfolio after Order already saved — fill requires manual reconciliation', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        error: portfolioResult.error.message,
      });
      // Снимаем флаги даже при ошибке portfolio.
      // Ордер уже сохранён как terminal (выше), поэтому он не появится
      // в getOpenOrdersByInstrument. Но для чистоты — снимаем флаги.
      this._clearInFlightFlags(fill);
      const reconciliationReason = `ORDER_PORTFOLIO_DESYNC: ${portfolioResult.error.message}`;
      this._deps.orderStateStore.updateFillProcessingStatus(fill.id, 'RECONCILIATION_REQUIRED');
      await this._deps.processedFillRepo.markReconciliationRequired(fill.id, reconciliationReason);
      // Queryable issue в дополнение к processed-fill статусу (семантика
      // markReconciliationRequired не меняется). Сбой add() не маскирует Err ниже.
      await this._addReconciliationIssue(fill, {
        idSuffix: 'order-portfolio-desync',
        reason: reconciliationReason,
        stage: 'portfolio-apply-after-order-saved',
        error: portfolioResult.error.message,
      });
      return Err(new TradingError(
        `Failed to update portfolio (Order already committed — manual reconciliation required): ${portfolioResult.error.message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }

    // Запись в Ledger (sync) — ДО dust release.
    // Order+Portfolio уже committed выше. Ledger пишем РАНЬШЕ dust release,
    // чтобы при сбое dust release Ledger уже был записан, и dust-issue касался
    // ТОЛЬКО замороженной резервации (не «Ledger тоже отстаёт»).
    // Если recordFill бросит — частичный commit (Ledger отстаёт), retry этого
    // fillId бесполезен: Order defends против duplicate fill id →
    // RECONCILIATION_REQUIRED (терминально), НЕ markFailed, НЕ markApplied.
    try {
      this._deps.ledgerService.recordFill(fill);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = `ORDER_PORTFOLIO_LEDGER_DESYNC: ${message}`;
      this._logger.error('ORDER_PORTFOLIO_LEDGER_DESYNC: Ledger record failed after Order+Portfolio already committed — fill requires manual reconciliation', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        error: message,
      });
      this._clearInFlightFlags(fill);
      this._deps.orderStateStore.updateFillProcessingStatus(fill.id, 'RECONCILIATION_REQUIRED');
      await this._deps.processedFillRepo.markReconciliationRequired(fill.id, reason);
      await this._addReconciliationIssue(fill, {
        idSuffix: 'order-portfolio-ledger-desync',
        reason,
        stage: 'ledger-record-after-portfolio-apply',
        error: message,
      });
      return Err(new TradingError(
        `Failed to record fill in ledger (Order+Portfolio already committed — manual reconciliation required): ${message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }

    // Снять остаток резервации при FILLED через dust threshold.
    // Биржа округляет fill size (5.147233 → 5.14), ордер закрывается через dust threshold
    // (остаток 0.007233 < 0.01 = FILLED), но PortfolioService.applyFill снял резервацию
    // только на fillQty. Остаток застревает навсегда, блокируя будущие ордера.
    //
    // Выполняется ПОСЛЕ Ledger record: если dust release упадёт, Order/Portfolio/
    // Ledger уже консистентны, и остаётся ТОЛЬКО замороженная dust-резервация.
    // Сбой release здесь НЕ проглатывается: Order уже terminal (committed
    // saveSync + applyFill), а dust-резервация может остаться замороженной —
    // это Order↔Portfolio reservation desync. Retry этого fillId бесполезен
    // (duplicate fill defence в Order) → RECONCILIATION_REQUIRED, НЕ markApplied.
    if (updatedOrder.isTerminal) {
      const remainingQty = updatedOrder.remainingSize.value();
      if (remainingQty.gt(0)) {
        const isSell = fill.side === 'SELL';
        // instrumentId для SELL здесь всегда резолвится — applyFill выше уже
        // вернул бы Err на invalid tokenId; guard оставлен как defence.
        const dustInstrumentId = isSell ? assetIdToInstrumentId(fill.tokenId) : undefined;
        const dustNotional = isSell ? undefined : remainingQty.times(order.price.value());

        let dustReleaseResult: ReturnType<PortfolioService['releaseReservation']> = Ok(undefined);
        if (isSell) {
          if (dustInstrumentId) {
            dustReleaseResult = this._deps.portfolioService.releaseTokenReservation(
              fill.accountId,
              dustInstrumentId,
              remainingQty,
            );
          }
        } else {
          dustReleaseResult = this._deps.portfolioService.releaseReservation(
            fill.accountId,
            dustNotional!,
          );
        }

        if (!dustReleaseResult.ok) {
          const message = dustReleaseResult.error.message;
          const reason = `DUST_RESERVATION_RELEASE_FAILED: ${message}`;
          this._logger.error('DUST_RESERVATION_RELEASE_FAILED: dust reservation release failed after terminal fill (Ledger already recorded) — reservation may stay frozen', {
            fillId: String(fill.id),
            orderId: String(fill.orderId),
            side: fill.side,
            remainingQty: remainingQty.toString(),
            error: message,
          });
          this._clearInFlightFlags(fill);
          this._deps.orderStateStore.updateFillProcessingStatus(fill.id, 'RECONCILIATION_REQUIRED');
          await this._deps.processedFillRepo.markReconciliationRequired(fill.id, reason);
          await this._addReconciliationIssue(fill, {
            idSuffix: 'dust-reservation-release-failed',
            reason,
            stage: 'dust-reservation-release-after-terminal-fill',
            error: message,
            extraContext: {
              side: fill.side,
              remainingQty: remainingQty.toString(),
              orderId: String(fill.orderId),
              ledgerRecorded: true,
            },
          });
          return Err(new TradingError(
            `Failed to release dust reservation after terminal fill (manual reconciliation required): ${message}`,
            { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
          ));
        }

        this._logger.info(
          isSell
            ? 'Released dust token reservation after SELL FILLED'
            : 'Released dust USDC reservation after BUY FILLED',
          {
            fillId: String(fill.id),
            orderId: String(fill.orderId),
            dustQty: remainingQty.toNumber(),
            ...(dustNotional !== undefined ? { dustNotional: dustNotional.toNumber() } : {}),
          },
        );
      }
    }

    // Синхронизация execution journal — COMMIT-CRITICAL (Этап 4): потребляем эту
    // часть, а при terminal Order атомарно consume+release одним transition →
    // SETTLED (запись не останется ложно HELD). Сбой journal ПОСЛЕ business
    // commit (Order/Portfolio/Ledger уже изменены) → RECONCILIATION_REQUIRED:
    // НЕ markApplied, processing-блок сохраняется, RESERVATION_JOURNAL_DESYNC
    // issue, fill НЕ retryable и НЕ применяется повторно.
    const journalSync = await this._syncJournalOnNormalFill(execution, order, fill, updatedOrder.isTerminal);
    if (!journalSync.ok) {
      const reason = `RESERVATION_JOURNAL_DESYNC: ${journalSync.error.message}`;
      this._logger.error('RESERVATION_JOURNAL_DESYNC: reservation journal transition failed after Order+Portfolio+Ledger committed — fill requires manual reconciliation', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        error: journalSync.error.message,
      });
      // Двухслойная защита: journal → RECONCILIATION_REQUIRED + manual block —
      // другой fillId этого ордера/инструмента блокируется до реконсиляции.
      if (execution) {
        await this._lockJournalDesync(fill, execution, reason);
      }
      this._clearInFlightFlags(fill);
      this._deps.orderStateStore.updateFillProcessingStatus(fill.id, 'RECONCILIATION_REQUIRED');
      await this._deps.processedFillRepo.markReconciliationRequired(fill.id, reason);
      await this._addReconciliationIssue(fill, {
        idSuffix: 'reservation-journal-desync',
        reason,
        stage: 'journal-sync-after-normal-fill-commit',
        error: journalSync.error.message,
        issueType: 'RESERVATION_JOURNAL_DESYNC',
      });
      return Err(new TradingError(
        `Failed to sync reservation journal after committed fill (manual reconciliation required): ${journalSync.error.message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }

    // Снимаем все in-flight флаги ПЕРЕД публикацией событий.
    // КРИТИЧНО: publishAll ниже — await, создаёт yield-окно.
    // Обработчики ORDER_FILLED (OrderEventBridge) запланируют тик стратегии
    // через microtask (Promise.resolve().then(processQueue)).
    // Если флаги не сняты ДО yield — стратегия увидит hasInFlightFills=true
    // на тике, который выполнится ВНУТРИ await → зависнет в HOLD навсегда.
    // Безопасно: если другой fill для того же ордера ещё в пути,
    // следующий MATCHED-event заново поставит флаг (под своим fillId).
    this._clearInFlightFlags(fill);

    // Order/Portfolio/Ledger уже закоммичены синхронно выше — помечаем APPLIED
    // ДО публикации событий. Публикация может упасть (EventBus.publishAll
    // реально бросает), но состояние уже применено: если пометить fill FAILED
    // здесь, retry заново вызовет order.applyFill(fillData) с тем же fill.id —
    // Order defends against duplicate fill id и просто вернёт ошибку "duplicate
    // fill" на каждой попытке, вечно оставляя fill в FAILED без реального
    // прогресса и маскируя истинную причину (сбой публикации, а не бизнес-ошибка).
    // Поэтому publish-ошибка не должна делать fill retryable — она логируется
    // отдельно как потеря уведомления, а не как неприменённая мутация.
    this._deps.orderStateStore.clearFillProcessing(fill.id);
    await this._deps.processedFillRepo.markApplied(fill.id);

    // ENQUEUE Order-событий в ordered outbox (aggregateId=orderId) — публикация
    // (flush) выполняется ПОСЛЕ выхода из lock (см. execute). Это сохраняет
    // per-order FIFO относительно Place-событий и исключает deadlock под lock.
    // Ошибка публикации (в flush) — потеря уведомления, НЕ делает fill retryable
    // (fill уже APPLIED); outbox логирует EVENT_PUBLISH_FAILED и создаёт issue.
    // К этому моменту: Order = terminal (если FILLED), Portfolio = обновлён, флаги сняты.
    const events = updatedOrder.pullEvents();
    await this._enqueueEvents(fill, events as readonly ApplicationEvent[]);

    // Диагностика: при BUY fill с fee > 0 логируем fee deduction в токенах.
    // Polymarket on-chain settlement списывает fee из получаемых токенов (BUY).
    // feeInTokens = feeUSDC / price — конвертация из USDC в shares.
    // PortfolioService уже вычел feeInTokens из позиции при BUY.
    if (fill.side === 'BUY' && !fill.fee.isZero()) {
      const feeUSDC = fill.fee.quantity.amount().value();
      const fillPrice = fill.price.value();
      const feeInTokens = feeUSDC.div(fillPrice);
      const grossTokens = fill.size.value();
      this._logger.info('BUY fill fee deduction applied to portfolio', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        grossTokens: grossTokens.toNumber(),
        feeUSDC: feeUSDC.toNumber(),
        feeInTokens: feeInTokens.toNumber(),
        netTokens: grossTokens.minus(feeInTokens).toNumber(),
        price: fillPrice.toNumber(),
      });
    }

    this._logger.info('Fill processed successfully', {
      fillId: String(fill.id),
      orderId: String(fill.orderId),
      newOrderStatus: updatedOrder.status,
    });

    return Ok(undefined);
  }

  /**
   * Held-reservation recovery path — нет живого Order, но есть held-резервация.
   *
   * @param fill - Исполнение ордера
   * @param execution - execution journal с held-резервацией
   * @returns Ok(void) при успехе, Err при ошибке
   *
   * @remarks
   * Сценарий: ambiguous submit получил venueOrderId, но локальный Order не был
   * сохранён; капитал заморожен (`reservation.status ∈ {HELD, PARTIALLY_SETTLED}`).
   * Fill потребляет ЭТУ резервацию (`applyFillAgainstHeldReservation`), а НЕ
   * дебетует available второй раз. Journal — источник истины для этого пути,
   * поэтому его consume commit-critical: сбой ПОСЛЕ Portfolio → RECONCILIATION_REQUIRED.
   * Order aggregate отсутствует → публикуем `DIRECT_FILL_APPLIED` (нет Order events).
   */
  private async _applyHeldReservationFill(
    fill: Fill,
    execution: OrderSubmissionRecord,
  ): Promise<Result<void, TradingError>> {
    this._logger.warn('Fill arrived without live local Order but held reservation exists — recovery path (consume held reservation)', {
      fillId: String(fill.id),
      orderId: String(fill.orderId),
      clientOrderId: String(execution.clientOrderId),
      side: fill.side,
      reservationStatus: execution.reservation.status,
      reservationRemaining: execution.reservation.remaining,
    });

    const orderPrice = new Decimal(execution.orderPrice);

    // ПРЕВАЛИДАЦИЯ (Этап 3): fill сверяется с execution journal ДО любых
    // мутаций Portfolio/Ledger/journal. Любое расхождение → reconciliation-блок
    // без изменения состояния (issue содержит фактические и ожидаемые значения).
    const validationError = this._validateHeldFill(fill, execution, orderPrice);
    if (validationError) {
      return this._blockFillOnReconciliation(fill, {
        idSuffix: 'held-fill-validation-failed',
        reason: `HELD_FILL_VALIDATION_FAILED: ${validationError.reason}`,
        stage: 'held-fill-prevalidation',
        error: validationError.reason,
        extraContext: {
          clientOrderId: String(execution.clientOrderId),
          ...validationError.context,
        },
      });
    }

    const applyResult = this._deps.portfolioService.applyFillAgainstHeldReservation({
      fill,
      orderPrice,
      reservationKind: execution.reservation.kind,
    });
    if (!applyResult.ok) {
      // Portfolio НЕ изменился → retryable.
      this._logger.error('Held-reservation fill portfolio update failed', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        error: applyResult.error.message,
      });
      this._clearInFlightFlags(fill);
      this._deps.orderStateStore.updateFillProcessingStatus(fill.id, 'FAILED_RETRYABLE');
      await this._deps.processedFillRepo.markFailed(fill.id, applyResult.error.message);
      return Err(new TradingError(
        `Held-reservation fill portfolio update failed: ${applyResult.error.message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }

    // Ledger. Portfolio уже применён — сбой recordFill → RECONCILIATION_REQUIRED.
    try {
      this._deps.ledgerService.recordFill(fill);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = `ORDER_PORTFOLIO_LEDGER_DESYNC: ${message}`;
      this._logger.error('ORDER_PORTFOLIO_LEDGER_DESYNC: Ledger record failed after held-reservation Portfolio committed — manual reconciliation', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        error: message,
      });
      this._clearInFlightFlags(fill);
      this._deps.orderStateStore.updateFillProcessingStatus(fill.id, 'RECONCILIATION_REQUIRED');
      await this._deps.processedFillRepo.markReconciliationRequired(fill.id, reason);
      await this._addReconciliationIssue(fill, {
        idSuffix: 'order-portfolio-ledger-desync',
        reason,
        stage: 'ledger-record-after-held-reservation-fill',
        error: message,
      });
      return Err(new TradingError(
        `Failed to record held-reservation fill in ledger (Portfolio committed — manual reconciliation required): ${message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }

    // Journal consume — commit-critical: journal источник истины для held-пути.
    // Attempt-scoped operationId: операции разных попыток не считаются дубликатами.
    // Rejection репозитория (throw) обрабатывается как Err (P1: exception boundary).
    const consumeAmount = this._consumeAmount(fill, orderPrice);
    let journalError: string | undefined;
    try {
      const journalResult = await this._deps.submissions.applyReservationTransition(execution.clientOrderId, {
        operationId: `attempt:${execution.attempt}:fill:${String(fill.id)}`,
        consume: consumeAmount,
        now: this._deps.clock?.now() ?? new Date(),
      });
      if (!journalResult.ok) {
        journalError = journalResult.error.message;
      }
    } catch (err) {
      journalError = err instanceof Error ? err.message : String(err);
    }
    if (journalError !== undefined) {
      const reason = `RESERVATION_JOURNAL_DESYNC: ${journalError}`;
      this._logger.error('RESERVATION_JOURNAL_DESYNC: reservation journal consume failed after held Portfolio+Ledger committed — manual reconciliation', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        clientOrderId: String(execution.clientOrderId),
        error: journalError,
      });
      // Двухслойная защита: journal → RECONCILIATION_REQUIRED + manual block —
      // другой fillId этого ордера/инструмента не пройдёт held/normal path.
      await this._lockJournalDesync(fill, execution, reason);
      this._clearInFlightFlags(fill);
      this._deps.orderStateStore.updateFillProcessingStatus(fill.id, 'RECONCILIATION_REQUIRED');
      await this._deps.processedFillRepo.markReconciliationRequired(fill.id, reason);
      await this._addReconciliationIssue(fill, {
        idSuffix: 'reservation-journal-desync',
        reason,
        stage: 'journal-consume-after-held-reservation-fill',
        error: journalError,
        issueType: 'RESERVATION_JOURNAL_DESYNC',
      });
      return Err(new TradingError(
        `Failed to consume reservation journal for held-reservation fill (manual reconciliation required): ${journalError}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }

    this._clearInFlightFlags(fill);
    // Portfolio/Ledger/journal committed → APPLIED до публикации (см. direct path).
    this._deps.orderStateStore.clearFillProcessing(fill.id);
    await this._deps.processedFillRepo.markApplied(fill.id);

    // Нет Order aggregate → DIRECT_FILL_APPLIED через outbox (aggregateId=orderId).
    await this._enqueueEvents(fill, [{ type: 'DIRECT_FILL_APPLIED', fill } as ApplicationEvent]);

    return Ok(undefined);
  }

  /**
   * Фиксирует journal desync после business commit: best-effort перевод журнала
   * в RECONCILIATION_REQUIRED + typed manual reconciliation block.
   *
   * @param fill - Fill, обработка которого привела к desync
   * @param execution - Запись execution journal (для clientOrderId/attempt)
   * @param reason - Причина (English, для block/оператора)
   *
   * @remarks
   * Двухслойная защита от P0-сценария «journal остался HELD после business
   * commit, задержанный/другой fill выбирает held-path»:
   * 1. Журнал → RECONCILIATION_REQUIRED (reservation-status guard блокирует fills);
   * 2. Manual block (guard в начале `_processLocked` блокирует fills, даже если
   *    пометка журнала тоже упала). Block НЕ снимается fill-ами.
   */
  private async _lockJournalDesync(fill: Fill, execution: OrderSubmissionRecord, reason: string): Promise<void> {
    try {
      const r = await this._deps.submissions.applyReservationTransition(execution.clientOrderId, {
        operationId: `attempt:${execution.attempt}:fill:${String(fill.id)}:journal-desync`,
        status: 'RECONCILIATION_REQUIRED',
        now: this._deps.clock?.now() ?? new Date(),
      });
      if (!r.ok) {
        this._logger.error('Failed to mark reservation journal RECONCILIATION_REQUIRED after fill journal desync', {
          fillId: String(fill.id),
          clientOrderId: String(execution.clientOrderId),
          error: r.error.message,
        });
      }
    } catch (err) {
      this._logger.error('Failed to mark reservation journal RECONCILIATION_REQUIRED after fill journal desync (threw)', {
        fillId: String(fill.id),
        clientOrderId: String(execution.clientOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
    const instrumentId = assetIdToInstrumentId(fill.tokenId);
    if (instrumentId) {
      this._deps.orderStateStore.markManualReconciliationBlock({
        orderId: fill.orderId,
        instrumentId,
        reason,
      });
    }
  }

  /**
   * Сумма consume для reservation journal по стороне fill.
   *
   * @param fill - Исполнение
   * @param orderPrice - Цена ордера (для BUY notional)
   * @returns decimal-строка: BUY → orderPrice × size (USDC), SELL → size (токены)
   */
  private _consumeAmount(fill: Fill, orderPrice: Decimal): string {
    return fill.side === 'BUY'
      ? orderPrice.times(fill.size.value()).toString()
      : fill.size.value().toString();
  }

  /**
   * Превалидация held-reservation fill против execution journal (Этап 3).
   *
   * @param fill - Исполнение
   * @param execution - Запись execution journal с held-резервацией
   * @param orderPrice - Цена ордера из журнала (Decimal)
   * @returns `undefined` если всё согласовано; иначе `{ reason, context }`
   *   с фактическими и ожидаемыми значениями
   *
   * @remarks
   * Проверки (все ДО каких-либо мутаций):
   * 1. `fill.accountId === execution.accountId` — fill чужого аккаунта не может
   *    потреблять нашу резервацию.
   * 2. `fill.side === execution.side`.
   * 3. `assetIdToInstrumentId(fill.tokenId) === execution.instrumentId`.
   * 4. `reservation.kind` соответствует стороне (BUY→USDC, SELL→TOKENS).
   * 5. `reservation.status ∈ {HELD, PARTIALLY_SETTLED}` (canConsumeHeldReservation).
   * 6. `consumeAmount > 0` и `consumeAmount <= reservation.remaining`.
   * 7. Cumulative consumed fill size не превышает `effectiveSize ?? requestedSize`:
   *    journal хранит capital amounts, поэтому consumed size вычисляется —
   *    BUY: `consumed / orderPrice`, SELL: `consumed`; максимальный оставшийся
   *    size — BUY: `remaining / orderPrice`, SELL: `remaining`.
   */
  private _validateHeldFill(
    fill: Fill,
    execution: OrderSubmissionRecord,
    orderPrice: Decimal,
  ): { readonly reason: string; readonly context: Record<string, string> } | undefined {
    // Канонический ключ аккаунта: AccountId — object union (WALLET/VENUE/...),
    // но защищаемся и от legacy string-представления (typeof-ветка).
    const accountKey = (id: typeof fill.accountId): string =>
      typeof id === 'string' ? id : accountIdToString(id);
    const fillAccount = accountKey(fill.accountId);
    const executionAccount = accountKey(execution.accountId);
    if (fillAccount !== executionAccount) {
      return {
        reason: `fill accountId mismatch: fill=${fillAccount} execution=${executionAccount}`,
        context: { actualAccountId: fillAccount, expectedAccountId: executionAccount },
      };
    }
    if (fill.side !== execution.side) {
      return {
        reason: `fill side mismatch: fill=${fill.side} execution=${execution.side}`,
        context: { actualSide: fill.side, expectedSide: execution.side },
      };
    }
    const fillInstrumentId = assetIdToInstrumentId(fill.tokenId);
    if (!fillInstrumentId || String(fillInstrumentId) !== String(execution.instrumentId)) {
      return {
        reason: `fill instrument mismatch: fill=${fillInstrumentId ? String(fillInstrumentId) : 'unresolved'} execution=${String(execution.instrumentId)}`,
        context: {
          actualInstrumentId: fillInstrumentId ? String(fillInstrumentId) : 'unresolved',
          expectedInstrumentId: String(execution.instrumentId),
        },
      };
    }
    const expectedKind = fill.side === 'BUY' ? 'USDC' : 'TOKENS';
    if (execution.reservation.kind !== expectedKind) {
      return {
        reason: `reservation kind mismatch: reservation=${execution.reservation.kind} expected=${expectedKind} for side=${fill.side}`,
        context: { actualKind: execution.reservation.kind, expectedKind },
      };
    }
    if (!canConsumeHeldReservation(execution.reservation)) {
      return {
        reason: `reservation not consumable: status=${execution.reservation.status} remaining=${execution.reservation.remaining}`,
        context: {
          reservationStatus: execution.reservation.status,
          reservationRemaining: execution.reservation.remaining,
        },
      };
    }
    const consumeAmount = new Decimal(this._consumeAmount(fill, orderPrice));
    const remaining = new Decimal(execution.reservation.remaining);
    if (consumeAmount.lessThanOrEqualTo(0)) {
      return {
        reason: `consume amount must be > 0, got ${consumeAmount.toString()}`,
        context: { consumeAmount: consumeAmount.toString() },
      };
    }
    if (consumeAmount.greaterThan(remaining)) {
      return {
        reason: `consume amount exceeds reservation remaining: consume=${consumeAmount.toString()} remaining=${remaining.toString()}`,
        context: { consumeAmount: consumeAmount.toString(), reservationRemaining: remaining.toString() },
      };
    }
    // Размер: cumulative consumed size + fill.size не должен превышать
    // effective/requested size. Journal хранит capital amounts → size вычисляем.
    const maxSize = new Decimal(execution.effectiveSize ?? execution.requestedSize);
    const consumedCapital = new Decimal(execution.reservation.consumed);
    const consumedSize = fill.side === 'BUY' ? consumedCapital.dividedBy(orderPrice) : consumedCapital;
    const cumulativeSize = consumedSize.plus(fill.size.value());
    if (cumulativeSize.greaterThan(maxSize)) {
      return {
        reason: `cumulative fill size exceeds order size: consumedSize=${consumedSize.toString()} + fillSize=${fill.size.value().toString()} > maxSize=${maxSize.toString()}`,
        context: {
          consumedSize: consumedSize.toString(),
          fillSize: fill.size.value().toString(),
          maxSize: maxSize.toString(),
          effectiveSize: execution.effectiveSize ?? 'undefined',
          requestedSize: execution.requestedSize,
        },
      };
    }
    return undefined;
  }

  /**
   * Синхронизирует execution journal для normal fill — COMMIT-CRITICAL (Этап 4).
   *
   * @param execution - execution journal (может отсутствовать)
   * @param order - Order (для orderPrice)
   * @param fill - Исполнение
   * @param orderTerminal - Стал ли Order terminal после fill
   * @returns `Ok(record | undefined)` — обновлённая запись (undefined, если
   *   журнал отсутствует/не имеет резервации); `Err(TradingError)` при сбое
   *   transition (caller переводит fill в RECONCILIATION_REQUIRED)
   *
   * @remarks
   * ### Атомарный terminal transition (4.1):
   * Для terminal Order consume и terminal release выполняются ОДНИМ transition
   * (`consume + release = remainingBefore`) с operationId
   * `attempt:${attempt}:fill:${fillId}:terminal` — резервация атомарно переходит
   * в SETTLED, окно между отдельными consume и terminal-settle устранено.
   * Partial fill — одиночный consume с `attempt:${attempt}:fill:${fillId}`.
   *
   * ### Сбой journal ПОСЛЕ business commit (4.2):
   * Order/Portfolio/Ledger уже изменены — caller при Err ОБЯЗАН: не вызывать
   * markApplied, перевести processed fill в RECONCILIATION_REQUIRED, сохранить
   * processing-блок, создать `RESERVATION_JOURNAL_DESYNC` issue. Retry запрещён
   * (Order duplicate-defence зациклил бы его без восстановления журнала).
   */
  private async _syncJournalOnNormalFill(
    execution: OrderSubmissionRecord | undefined,
    order: Order,
    fill: Fill,
    orderTerminal: boolean,
  ): Promise<Result<OrderSubmissionRecord | undefined, TradingError>> {
    if (!execution) return Ok(undefined);
    // NONE — журнал никогда не фиксировал резервацию под этот ордер (например,
    // старые записи до commit-critical hold): consume был бы ложным OVER_CONSUME.
    if (execution.reservation.status === 'NONE') {
      this._logger.warn('Execution journal has no reservation (NONE) for normal fill — journal sync skipped', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        clientOrderId: String(execution.clientOrderId),
      });
      return Ok(undefined);
    }
    const consumeAmount = new Decimal(this._consumeAmount(fill, order.price.value()));
    try {
      let transition: {
        readonly operationId: string;
        readonly consume?: string;
        readonly release?: string;
        readonly now: Date;
      };
      if (orderTerminal) {
        // Атомарно: consume этой части + release остатка → SETTLED одним transition.
        const remainingBefore = new Decimal(execution.reservation.remaining);
        const release = remainingBefore.minus(consumeAmount);
        transition = {
          operationId: `attempt:${execution.attempt}:fill:${String(fill.id)}:terminal`,
          consume: consumeAmount.toString(),
          ...(release.greaterThan(0) ? { release: release.toString() } : {}),
          now: this._deps.clock?.now() ?? new Date(),
        };
      } else {
        transition = {
          operationId: `attempt:${execution.attempt}:fill:${String(fill.id)}`,
          consume: consumeAmount.toString(),
          now: this._deps.clock?.now() ?? new Date(),
        };
      }
      const r = await this._deps.submissions.applyReservationTransition(execution.clientOrderId, transition);
      if (!r.ok) {
        return Err(new TradingError(
          `Reservation journal transition failed on normal fill: ${r.error.message}`,
          { context: { fillId: String(fill.id), orderId: String(fill.orderId), operationId: transition.operationId } },
        ));
      }
      return Ok(r.value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(new TradingError(
        `Reservation journal transition threw on normal fill: ${message}`,
        { context: { fillId: String(fill.id), orderId: String(fill.orderId) } },
      ));
    }
  }

  /**
   * Best-effort создание reconciliation issue при частичном commit fill.
   *
   * @param fill - Fill, обработка которого привела к частичному commit
   * @param params - `idSuffix` (детерминированный суффикс id), `reason`
   *   (та же причина, что в `markReconciliationRequired()`), `stage`
   *   (этап частичного commit для context), `error` (исходная ошибка)
   *
   * @remarks
   * No-op, если `reconciliationIssues` не передан в deps (optional dependency —
   * прежнее поведение сохраняется). Id детерминированный
   * (`reconciliation:fill:${fill.id}:${idSuffix}`) — `add()` идемпотентен,
   * повторная попытка не создаст дубль. Любая ошибка `add()` логируется и
   * проглатывается: issue — вторичный alerting-механизм, он не должен
   * маскировать исходную trading-ошибку и не должен менять исходный
   * error path (`markReconciliationRequired` + Err).
   */
  private async _addReconciliationIssue(
    fill: Fill,
    params: {
      readonly idSuffix: string;
      readonly reason: string;
      readonly stage: string;
      readonly error: string;
      /** Дополнительные non-sensitive поля context (сливаются со stage/error) */
      readonly extraContext?: Readonly<Record<string, string | number | boolean | null>>;
      /** Тип issue (по умолчанию ORDER_PORTFOLIO_DESYNC). */
      readonly issueType?: 'ORDER_PORTFOLIO_DESYNC' | 'RESERVATION_JOURNAL_DESYNC';
    },
  ): Promise<void> {
    if (!this._deps.reconciliationIssues) {
      return;
    }
    const instrumentId = assetIdToInstrumentId(fill.tokenId);
    try {
      await this._deps.reconciliationIssues.add({
        id: `reconciliation:fill:${String(fill.id)}:${params.idSuffix}`,
        type: params.issueType ?? 'ORDER_PORTFOLIO_DESYNC',
        status: 'OPEN',
        reason: params.reason,
        createdAt: this._deps.clock?.now() ?? new Date(),
        fillId: fill.id,
        orderId: fill.orderId,
        accountId: fill.accountId,
        ...(instrumentId ? { instrumentId } : {}),
        context: {
          stage: params.stage,
          error: params.error,
          ...(params.extraContext ?? {}),
        },
      });
    } catch (err) {
      this._logger.error('Failed to add reconciliation issue', {
        fillId: String(fill.id),
        orderId: String(fill.orderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Снимает in-flight флаги этого КОНКРЕТНОГО fill: order-level matched + instrument-level in-flight.
   *
   * @param fill - Обработанный fill
   *
   * @remarks
   * fillId-scoped (не order/instrument-wide) — партиальные fills того же
   * ордера/инструмента с ДРУГИМИ fillId не затрагиваются. Вызывается после
   * обработки fill (или на error path).
   *
   * Дополнительно снимается instrument-level placeholder
   * `pendingMatchFillId(fill.orderId)`: реальный fill «разрешает» более раннюю
   * неоднозначную пометку от cancel ALREADY_FILLED / submit FILLED (там
   * конкретный fillId неизвестен). Order-level placeholder аналогично снимает
   * `clearOrderFillMatched`. Placeholder снимается при ПЕРВОМ реальном fill
   * ордера; реальные fillId других partial fills не затрагиваются
   * (clearInFlightFill — no-op для неизвестных id).
   */
  private _clearInFlightFlags(fill: Fill): void {
    this._deps.orderStateStore.clearOrderFillMatched(fill.orderId, fill.id);
    this._deps.orderStateStore.clearInFlightFill(fill.id);
    this._deps.orderStateStore.clearInFlightFill(pendingMatchFillId(fill.orderId));
  }
}
