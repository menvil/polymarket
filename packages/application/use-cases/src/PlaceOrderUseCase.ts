/**
 * PlaceOrderUseCase — оркестрация размещения нового торгового ордера.
 *
 * @remarks
 * ### Алгоритм:
 * 1a. Дешёвый риск-precheck (OrderRiskChecker) на snapshot из input — вне lock,
 *     fail-fast. НЕ authoritative.
 *
 * Шаги 1b–6 выполняются ВНУТРИ keyed mutex по [accountId, instrumentId]
 * (пересекается с lock-ключами ProcessFillUseCase/CancelOrderUseCase):
 * WS fill, прилетевший между submitOrder и локальным save, ждёт завершения
 * Place и находит сохранённый Order вместо ухода в direct-fill path.
 * Lock удерживается на время network call submitOrder — осознанный
 * single-process компромисс. publishAll вынесен ЗА lock (шаг 7).
 * TODO: replace long-held venue lock with PendingVenueOrderRegistry / UnitOfWork.
 *
 * 1b. Authoritative риск-проверка на СВЕЖЕМ portfolio (portfolioService.getPortfolio)
 *     и актуальном openOrdersCount (orderRepo.countByStrategyId) — устраняет
 *     гонку двух конкурентных execute() на устаревшем snapshot.
 * 2. Резервирование баланса (portfolio.reserveForOrder)
 * 3. Отправка на биржу (exchangeClient.submitOrder) → типизированный SubmitOrderResult:
 *    - `Err(ExchangeError)` (транспорт): по `submitOutcome` —
 *      `DEFINITELY_NOT_SUBMITTED` → чистый откат резервации + Err; иначе
 *      (`MAY_HAVE_BEEN_SUBMITTED` или поле не задано, conservative default) →
 *      трактуем как ambiguous: откат best-effort + `SUBMIT_UNKNOWN_OUTCOME` issue,
 *      Order НЕ создаётся, Err
 *    - `Ok({status: 'REJECTED'})`: откат резервации, Err, локальный Order НЕ создаётся
 *    - `Ok({status: 'UNKNOWN'})`: откат резервации, best-effort cancel (если есть orderId),
 *      Err — ambiguous venue-ответ никогда не превращается в обычный OPEN order.
 *      Если в deps передан `reconciliationIssues` — дополнительно создаётся
 *      `SUBMIT_UNKNOWN_OUTCOME` issue (даже при успешном cancel: исход submit
 *      был ambiguous), best-effort — сбой add() не меняет Err
 *    - `Ok({status: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED'})`: venueOrderId получен,
 *      продолжаем шаги 4-7
 * 4. Создание Order aggregate с **venueOrderId** (Order.create → PENDING)
 * 5. Принятие ордера (order.accept → OPEN)
 * 6. Сохранение ордера в репозиторий (с venueOrderId!) — CAS save с expectedVersion=0
 *    (новый ордер); конфликт версии → best-effort отмена на бирже + откат резервации.
 *    Сразу после успешного save, ДО публикации событий — для `PARTIALLY_FILLED`/
 *    `FILLED` вызывается `markOrderFillMatched(venueOrderId, pendingMatchFillId(...))`,
 *    БЕЗ синтеза Fill: реальный `Fill` придёт отдельно через WS/reconciliation и
 *    применится к Portfolio в `ProcessFillUseCase`. Порядок важен: события (в т.ч.
 *    ORDER_ACCEPTED) публикуются синхронно всем подписчикам (`EventBus.publishAll`
 *    дренирует handlers немедленно), и `OrderEventBridge`/стратегия могут отреагировать
 *    на ORDER_ACCEPTED раньше, чем marker будет виден в `IOrderStateStore` — если
 *    marker ставится ПОСЛЕ publishAll, стратегия успеет попытаться cancel/reprice
 *    ордер, который на самом деле уже исполнен. Для `FILLED` (live-ордера уже нет,
 *    Portfolio ждёт реальный Fill) после save+marker и ДО publishAll дополнительно
 *    создаётся `SUBMIT_FILLED_WITHOUT_FILL_DETAILS` reconciliation issue (если в
 *    deps передан `reconciliationIssues`); для `PARTIALLY_FILLED` issue не создаётся —
 *    ордер live, pending marker достаточен.
 * 7. Публикация доменных событий — `eventBus.publishAll(order.pullEvents())`,
 *    ВНУТРИ lock (после save+markers+issues). Публикация под lock гарантирует
 *    per-order порядок: конкурентный Fill, ждущий тот же mutex, не опубликует
 *    `ORDER_FILLED` раньше `ORDER_CREATED`/`ORDER_ACCEPTED`. Публикация после
 *    успешного commit — notification path, НЕ часть транзакции: её сбой
 *    логируется как `EVENT_PUBLISH_FAILED`, создаётся queryable
 *    `EVENT_PUBLISH_FAILED` issue (для ручного replay) и возвращается
 *    `Ok(venueOrderId)` (state не откатывается; Err сделал бы committed operation
 *    retryable — повторный вызов создал бы дублирующий ордер на venue).
 *
 * ### Почему Order создаётся ПОСЛЕ отправки на биржу:
 * Polymarket возвращает свой orderId (0xa928...) при размещении.
 * Именно этот venueOrderId используется во всех WS-событиях (fills, order updates).
 * Order хранится в репозитории под venueOrderId — только так OrderUpdateHandler
 * и FillEventHandler смогут найти ордер по ID из WS-событий.
 * input.orderId используется как clientOrderId для идемпотентности retry.
 *
 * ### Идемпотентность:
 * input.orderId (внутренний UUID) передаётся в биржу как clientOrderId для retry.
 * При ошибке биржи резервация автоматически откатывается.
 *
 * @example
 * ```typescript
 * const useCase = new PlaceOrderUseCase({
 *   riskChecker, orderRepo, portfolioService, exchangeClient, eventBus, clock, logger,
 * });
 *
 * const result = await useCase.execute({
 *   orderId, accountId, asset, side: 'BUY', price, size, strategyId, openOrdersCount,
 * });
 *
 * if (result.ok) {
 *   console.log('Order placed:', result.value);
 * }
 * ```
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import { TimestampService } from '@polymarket/value-objects';
import type { Price, Quantity, Side } from '@polymarket/value-objects';
import type { AccountId, AssetId, InstrumentId, OrderId } from '@polymarket/ids';
import { accountIdToString } from '@polymarket/ids';
import type {
  IExchangeClient,
  IKeyedMutex,
  IOrderRepository,
  IOrderStateStore,
  IOrderSubmissionRepository,
  IReconciliationIssueRepository,
  ReconciliationIssue,
  SubmitOrderParams,
} from '@polymarket/ports';
import { pendingMatchFillId } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';
import { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import type { IOrderRiskChecker, RiskViolationError } from '@polymarket/risk';
import type { PortfolioService } from './services/PortfolioService.js';

/** Входные данные для PlaceOrderUseCase */
export interface PlaceOrderInput {
  /**
   * Внутренний ID ордера — используется как clientOrderId для идемпотентности retry.
   * Фактический orderId ордера будет venueOrderId, возвращённый биржей.
   * Use case вернёт Ok(venueOrderId), а не Ok(orderId).
   */
  readonly orderId: OrderId;
  /** ID аккаунта владельца ордера */
  readonly accountId: AccountId;
  /** Торгуемый актив */
  readonly asset: AssetId;
  /** ID инструмента (для риск-проверки позиции) */
  readonly instrumentId: InstrumentId;
  /** Сторона (BUY/SELL) */
  readonly side: Side;
  /** Лимитная цена */
  readonly price: Price;
  /** Размер ордера */
  readonly size: Quantity;
  /** true = post-only order; exchange must reject if order would execute immediately */
  readonly postOnly?: boolean;
  /** Venue order type. For Polymarket CLOB, FAK is the IOC analogue. */
  readonly orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK';
  /** ID стратегии (опционально) */
  readonly strategyId?: string;
  /** Текущий portfolio (для риск-проверки) */
  readonly portfolio: Portfolio;
  /** Количество открытых ордеров стратегии (для риск-проверки) */
  readonly openOrdersCount: number;
}

/** Зависимости PlaceOrderUseCase */
export interface PlaceOrderDeps {
  readonly riskChecker: IOrderRiskChecker;
  readonly orderRepo: IOrderRepository;
  readonly portfolioService: PortfolioService;
  readonly exchangeClient: IExchangeClient;
  readonly orderStateStore: IOrderStateStore;
  /**
   * Keyed mutex — сериализует reserve+submit+local save относительно
   * `ProcessFillUseCase`/`CancelOrderUseCase` по [accountId, instrumentId].
   *
   * @remarks
   * Закрывает race «submitOrder → WS fill → local save»: без lock fill,
   * прилетевший между submit и сохранением Order, не находил Order и уходил
   * в direct-fill path (BUY дебетует available, исходная резервация остаётся
   * замороженной), после чего Place сохранял OPEN order → desync.
   */
  readonly keyedMutex: IKeyedMutex;
  readonly eventBus: IEventBus;
  readonly clock: IClock;
  readonly logger: ILogger;
  /**
   * Queryable хранилище reconciliation issues (опционально).
   *
   * @remarks
   * Optional — чтобы не ломать существующие конструкторы/тесты: без него
   * поведение прежнее (только logging). Если передан, создаются issues:
   * - `SUBMIT_UNKNOWN_OUTCOME` — при `SubmitOrderResult.UNKNOWN` (исход submit
   *   ambiguous, даже если best-effort cancel удался);
   * - `SUBMIT_FILLED_WITHOUT_FILL_DETAILS` — при `FILLED` (live-ордера уже нет,
   *   Portfolio нельзя обновить без реального Fill — ждём WS/reconciliation).
   * Сбой `add()` логируется и НЕ меняет результат use case.
   */
  readonly reconciliationIssues?: IReconciliationIssueRepository;
  /**
   * Submission guard по clientOrderId (опционально).
   *
   * @remarks
   * Optional — без него поведение прежнее. Если передан, защищает от небезопасного
   * повторного submit: повторный `execute()` с тем же `input.orderId` после
   * committed submit возвращает существующий venueOrderId БЕЗ повторного submit и
   * БЕЗ rollback cancel; save-conflict с уже committed submission не отменяет
   * venue-ордер; ambiguous submit (UNKNOWN/MAY_HAVE_BEEN_SUBMITTED) блокирует
   * авто-retry. Вызывается ВНУТРИ keyed mutex (см. `_placeLocked`).
   */
  readonly submissions?: IOrderSubmissionRepository;
}

/** Ошибки PlaceOrderUseCase */
export type PlaceOrderError = TradingError | RiskViolationError;

/**
 * Результат успешной критической секции размещения (внутри lock).
 *
 * @remarks
 * Commit (CAS save + markers + issues) И публикация событий выполнены ВНУТРИ
 * lock к моменту возврата — `execute()` только пробрасывает venueOrderId наружу.
 */
interface PlaceCommitResult {
  readonly venueOrderId: OrderId;
}

/**
 * Use case размещения торгового ордера.
 *
 * @remarks
 * Оркестрирует пре-трейд проверку, создание ордера, резервирование средств
 * и отправку на биржу. При ошибке на любом шаге обеспечивает откат.
 */
export class PlaceOrderUseCase {
  private readonly _logger: ILogger;

  /**
   * @param deps - Зависимости use case
   */
  constructor(private readonly _deps: PlaceOrderDeps) {
    this._logger = _deps.logger.child({ component: 'PlaceOrderUseCase' });
  }

  /**
   * Помечает submission как FAILED (retry допустим) — best-effort, no-op без repo.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param reason - Причина
   */
  private async _markSubmissionFailed(clientOrderId: OrderId, reason: string): Promise<void> {
    if (!this._deps.submissions) return;
    try {
      await this._deps.submissions.markFailed(clientOrderId, reason, this._deps.clock.now());
    } catch (err) {
      this._logger.error('Failed to mark submission FAILED', {
        clientOrderId: String(clientOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Помечает submission как UNKNOWN (venue-ордер мог быть создан) — best-effort.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param reason - Причина
   * @param venueOrderId - venue orderId, если известен
   */
  private async _markSubmissionUnknown(
    clientOrderId: OrderId,
    reason: string,
    venueOrderId?: OrderId,
  ): Promise<void> {
    if (!this._deps.submissions) return;
    try {
      await this._deps.submissions.markUnknown(clientOrderId, reason, venueOrderId, this._deps.clock.now());
    } catch (err) {
      this._logger.error('Failed to mark submission UNKNOWN', {
        clientOrderId: String(clientOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Best-effort создание reconciliation issue (SUBMIT_UNKNOWN_OUTCOME /
   * SUBMIT_FILLED_WITHOUT_FILL_DETAILS).
   *
   * @param issue - Issue с детерминированным id (см. call sites)
   *
   * @remarks
   * No-op, если `reconciliationIssues` не передан в deps (optional dependency —
   * прежнее поведение сохраняется). `add()` идемпотентен по id — повторный
   * вызов того же сценария не создаёт дубль. Любая ошибка `add()` логируется
   * и проглатывается: issue — вторичный alerting-механизм, он не должен
   * менять результат use case (ни исходный Err в UNKNOWN-ветке, ни успешный
   * Ok в FILLED-ветке).
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
   * Best-effort issue при сбое release резервации в rollback-ветке.
   *
   * @param args - `releaseError` (сообщение ошибки release), `stage`
   *   (идентификатор rollback-ветки), `clientOrderId`, `accountId`,
   *   `instrumentId`, опциональный `venueOrderId` (если venue-ордер существовал)
   *
   * @remarks
   * Rollback-ветка уже возвращает свой Err, но упавший release означает,
   * что резервация может остаться замороженной (Order↔Portfolio desync) —
   * без queryable issue это было бы видно только в логах.
   * `ORDER_PORTFOLIO_DESYNC`, id детерминирован по venue/client orderId
   * (`reconciliation:place-rollback[…]:release-failed`) — в одном размещении
   * срабатывает максимум одна rollback-ветка, коллизий нет.
   * Сбой `add()` не маскирует исходный Err rollback-ветки.
   */
  private async _addRollbackReleaseIssue(args: {
    readonly releaseError: string;
    readonly stage: string;
    readonly clientOrderId: OrderId;
    readonly accountId: AccountId;
    readonly instrumentId: InstrumentId;
    readonly venueOrderId?: OrderId;
  }): Promise<void> {
    await this._addReconciliationIssue({
      id: args.venueOrderId
        ? `reconciliation:place-rollback:${String(args.venueOrderId)}:release-failed`
        : `reconciliation:place-rollback-client:${String(args.clientOrderId)}:release-failed`,
      type: 'ORDER_PORTFOLIO_DESYNC',
      status: 'OPEN',
      reason: `PLACE_ROLLBACK_RELEASE_FAILED: ${args.releaseError}`,
      createdAt: this._deps.clock.now(),
      ...(args.venueOrderId ? { orderId: args.venueOrderId } : {}),
      accountId: args.accountId,
      instrumentId: args.instrumentId,
      context: {
        stage: args.stage,
        clientOrderId: String(args.clientOrderId),
        ...(args.venueOrderId ? { venueOrderId: String(args.venueOrderId) } : {}),
      },
    });
  }

  /**
   * Обрабатывает исход best-effort venue-отмены в rollback-ветках:
   * логирует и для ambiguous исходов создаёт reconciliation issue.
   *
   * @param args - `venueOrderId`, результат `cancelOrder()`, `stage`
   *   (идентификатор rollback-ветки для context), `clientOrderId`,
   *   `accountId`/`instrumentId` (для issue),
   *   `transportErrorMessage` (текст лога при транспортном Err)
   *
   * @remarks
   * Не парсит `reason` из `CancelOrderResult` — только switch по типизированному
   * `status`. `CANCELLED` / `ALREADY_CANCELLED` / `NOT_FOUND` — завершённый или
   * идемпотентный rollback venue-стороны: не ошибка, issue не создаётся.
   * Ambiguous исходы становятся queryable issues (best-effort, сбой `add()`
   * не маскирует исходный Err rollback-ветки):
   * - `ALREADY_FILLED` → `VENUE_LOCAL_ORDER_DESYNC`: локальный Order НЕ сохранён
   *   (rollback), а venue-ордер исполнен — придёт fill на несуществующий ордер;
   * - `UNKNOWN_RETRY_NEEDED` / транспортный `Err` → `CANCEL_UNKNOWN_OUTCOME`:
   *   venue-ордер может быть live, локально его нет.
   */
  private async _handleRollbackCancelOutcome(args: {
    readonly venueOrderId: OrderId;
    readonly cancelResult: Awaited<ReturnType<IExchangeClient['cancelOrder']>>;
    readonly stage: string;
    readonly clientOrderId: OrderId;
    readonly accountId: AccountId;
    readonly instrumentId: InstrumentId;
    readonly transportErrorMessage: string;
  }): Promise<void> {
    const { venueOrderId, cancelResult, stage, clientOrderId, accountId, instrumentId } = args;
    const baseContext = {
      stage,
      clientOrderId: String(clientOrderId),
      // Во всех rollback-ветках локальный Order не сохранён (или save не удался).
      localOrderSaved: false,
    };

    if (!cancelResult.ok) {
      this._logger.error(args.transportErrorMessage, {
        venueOrderId: String(venueOrderId),
        error: cancelResult.error.message,
      });
      await this._addReconciliationIssue({
        id: `reconciliation:place-rollback:${String(venueOrderId)}:transport-error`,
        type: 'CANCEL_UNKNOWN_OUTCOME',
        status: 'OPEN',
        reason: `ROLLBACK_CANCEL_TRANSPORT_ERROR: ${cancelResult.error.message}`,
        createdAt: this._deps.clock.now(),
        orderId: venueOrderId,
        accountId,
        instrumentId,
        context: { ...baseContext, rollbackCancelOutcome: 'TRANSPORT_ERROR' },
      });
      return;
    }

    switch (cancelResult.value.status) {
      case 'CANCELLED':
      case 'ALREADY_CANCELLED':
      case 'NOT_FOUND':
        break;
      case 'ALREADY_FILLED':
        this._logger.error(
          'Rollback cancel failed — order already filled on exchange, manual reconciliation/fill expected',
          { venueOrderId: String(venueOrderId), reason: cancelResult.value.reason },
        );
        await this._addReconciliationIssue({
          id: `reconciliation:place-rollback:${String(venueOrderId)}:already-filled`,
          type: 'VENUE_LOCAL_ORDER_DESYNC',
          status: 'OPEN',
          reason: `ROLLBACK_CANCEL_ALREADY_FILLED: ${cancelResult.value.reason ?? 'already filled'}`,
          createdAt: this._deps.clock.now(),
          orderId: venueOrderId,
          accountId,
          instrumentId,
          context: { ...baseContext, rollbackCancelOutcome: 'ALREADY_FILLED' },
        });
        break;
      case 'UNKNOWN_RETRY_NEEDED':
        this._logger.error(
          'Rollback cancel outcome unclear — venue order may still be live, manual reconciliation required',
          { venueOrderId: String(venueOrderId), reason: cancelResult.value.reason },
        );
        await this._addReconciliationIssue({
          id: `reconciliation:place-rollback:${String(venueOrderId)}:unknown`,
          type: 'CANCEL_UNKNOWN_OUTCOME',
          status: 'OPEN',
          reason: `ROLLBACK_CANCEL_UNKNOWN_OUTCOME: ${cancelResult.value.reason}`,
          createdAt: this._deps.clock.now(),
          orderId: venueOrderId,
          accountId,
          instrumentId,
          context: { ...baseContext, rollbackCancelOutcome: 'UNKNOWN_RETRY_NEEDED' },
        });
        break;
    }
  }

  /**
   * Выполняет размещение ордера.
   *
   * @param input - Входные данные ордера и контекст риска
   * @returns Ok(OrderId) при успехе, Err(PlaceOrderError) при нарушении
   *
   * @throws Не бросает исключений — все ошибки возвращаются через Result
   */
  public async execute(input: PlaceOrderInput): Promise<Result<OrderId, PlaceOrderError>> {
    // Шаг 1a: Дешёвый precheck — вне lock (fail-fast на stale snapshot из input).
    // Не authoritative: два конкурентных execute() могут оба пройти его на
    // старом snapshot. Финальная, authoritative риск-проверка — внутри lock на
    // свежем portfolio + актуальном openOrdersCount (см. _placeLocked, шаг 1b).
    const precheckResult = this._deps.riskChecker.checkBeforeOrder({
      portfolio: input.portfolio,
      openOrdersCount: input.openOrdersCount,
      side: input.side,
      price: input.price,
      size: input.size,
      instrumentId: input.instrumentId,
      strategyId: input.strategyId,
    });
    if (!precheckResult.ok) {
      this._logger.warn('Pre-trade risk precheck failed (stale snapshot)', {
        riskCode: precheckResult.error.riskCode,
        clientOrderId: String(input.orderId),
      });
      return precheckResult;
    }

    // Keyed mutex по [accountId, instrumentId] — пересекается с lock-ключами
    // ProcessFillUseCase/CancelOrderUseCase (оба включают accountId, а fill
    // того же инструмента — и instrumentId). Закрывает race: WS fill,
    // прилетевший между submitOrder и локальным orderRepo.save, ждёт
    // завершения Place и находит сохранённый Order вместо ухода в
    // direct-fill path (frozen reservation + double debit).
    //
    // Lock осознанно удерживается на время network call submitOrder И публикации
    // событий — прагматичный single-process safety guard.
    // TODO: replace long-held venue lock with PendingVenueOrderRegistry / UnitOfWork.
    const lockKeys = [
      accountIdToString(input.accountId),
      String(input.instrumentId),
    ];
    const lockedResult = await this._deps.keyedMutex.runExclusive(
      lockKeys,
      () => this._placeLocked(input),
    );
    if (!lockedResult.ok) {
      return lockedResult;
    }
    return Ok(lockedResult.value.venueOrderId);
  }

  /**
   * Критическая секция размещения — вызывается ВНУТРИ keyed mutex.
   *
   * @param input - Входные данные ордера (risk check уже пройден)
   * @returns Ok(venueOrderId) при успехе, Err(PlaceOrderError) при ошибке
   *
   * @remarks
   * Внутри lock: reserve → submit → обработка REJECTED/UNKNOWN →
   * effectiveSize adjustment → Order.create/accept → CAS save → markers/issues →
   * **publish**. Публикация выполняется ВНУТРИ lock (шаг 7) — иначе конкурентный
   * Fill, ждущий тот же mutex, мог бы после release опубликовать `ORDER_FILLED`
   * раньше, чем Place опубликует `ORDER_CREATED`/`ORDER_ACCEPTED` (нарушение
   * per-order порядка событий). Состояние Portfolio/Order последовательно
   * относительно конкурентных fills/cancels этого инструмента/аккаунта.
   */
  private async _placeLocked(input: PlaceOrderInput): Promise<Result<PlaceCommitResult, PlaceOrderError>> {
    // Шаг 0: Submission guard по clientOrderId (если передан submissions).
    // Защита от небезопасного повторного submit того же clientOrderId: venue
    // идемпотентен по clientOrderId и может вернуть тот же venueOrderId; без
    // guard второй execute() попал бы в save-conflict и отменил бы успешно
    // созданный ордер. Выполняется ПЕРВЫМ (до reserve/submit).
    if (this._deps.submissions) {
      const begin = await this._deps.submissions.begin({
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        now: this._deps.clock.now(),
      });
      if (begin.outcome === 'ALREADY_COMMITTED') {
        // Повторный submit уже закоммиченного ордера — возвращаем существующий
        // venueOrderId, НЕ submit-им и НЕ cancel-им.
        const venueOrderId = begin.record.venueOrderId;
        if (venueOrderId) {
          this._logger.warn('Duplicate PlaceOrder for already-committed clientOrderId — returning existing venueOrderId', {
            clientOrderId: String(input.orderId),
            venueOrderId: String(venueOrderId),
          });
          return Ok({ venueOrderId });
        }
        // Committed без venueOrderId — не должно случаться; трактуем как in-progress.
      }
      if (begin.outcome === 'IN_PROGRESS') {
        return Err(new TradingError(
          `Order submission already in progress for clientOrderId: ${String(input.orderId)}`,
          { context: { clientOrderId: String(input.orderId) } },
        ));
      }
      if (begin.outcome === 'UNKNOWN') {
        // Прошлый submit был ambiguous — НЕ retry-им автоматически.
        this._logger.error('PlaceOrder blocked — prior submission for clientOrderId had UNKNOWN outcome, manual reconciliation required', {
          clientOrderId: String(input.orderId),
          venueOrderId: begin.record.venueOrderId ? String(begin.record.venueOrderId) : undefined,
        });
        await this._addReconciliationIssue({
          id: `reconciliation:submit-client:${String(input.orderId)}:unknown`,
          type: 'SUBMIT_UNKNOWN_OUTCOME',
          status: 'OPEN',
          reason: `PRIOR_SUBMISSION_UNKNOWN: ${begin.record.reason ?? 'ambiguous submit outcome'}`,
          createdAt: this._deps.clock.now(),
          ...(begin.record.venueOrderId ? { orderId: begin.record.venueOrderId } : {}),
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          context: { clientOrderId: String(input.orderId), submissionStatus: 'UNKNOWN' },
        });
        return Err(new TradingError(
          `Order submission blocked — prior UNKNOWN outcome for clientOrderId: ${String(input.orderId)}`,
          { context: { clientOrderId: String(input.orderId) } },
        ));
      }
      // ACQUIRED / FAILED_RETRYABLE → продолжаем.
    }

    // Шаг 1b: Authoritative риск-проверка на СВЕЖЕМ состоянии.
    // input.portfolio и input.openOrdersCount — snapshot, собранный ДО lock;
    // пока ждали lock, конкурентный place/fill мог изменить баланс/экспозицию
    // и число открытых ордеров. Перечитываем portfolio и openOrdersCount под
    // lock и повторяем проверку — иначе два конкурентных execute() оба прошли
    // бы лимиты по количеству/экспозиции на устаревшем snapshot, а затем
    // последовательно разместились бы, превысив лимит.
    const freshPortfolio = this._deps.portfolioService.getPortfolio(input.accountId) ?? input.portfolio;
    const freshOpenOrdersCount = await this._deps.orderRepo.countByStrategyId(input.strategyId);
    const riskResult = this._deps.riskChecker.checkBeforeOrder({
      portfolio: freshPortfolio,
      openOrdersCount: freshOpenOrdersCount,
      side: input.side,
      price: input.price,
      size: input.size,
      instrumentId: input.instrumentId,
      strategyId: input.strategyId,
    });
    if (!riskResult.ok) {
      this._logger.warn('Pre-trade risk check failed (authoritative, under lock)', {
        riskCode: riskResult.error.riskCode,
        clientOrderId: String(input.orderId),
        freshOpenOrdersCount,
      });
      // Ордер не отправлялся — submission можно retry-ить.
      await this._markSubmissionFailed(input.orderId, `RISK_CHECK_FAILED: ${riskResult.error.riskCode}`);
      return riskResult;
    }

    // Шаг 2: Резервирование ресурсов (BUY → USDC, SELL → токены)
    const isBuy = input.side === 'BUY';
    const notional = isBuy ? input.price.value().times(input.size.value()) : undefined;
    const reserveResult = isBuy
      ? this._deps.portfolioService.reserveForOrder(input.accountId, notional!)
      : this._deps.portfolioService.reserveTokensForOrder(
          input.accountId,
          input.instrumentId,
          input.size.value(),
        );
    if (!reserveResult.ok) {
      // Ордер не отправлялся — submission можно retry-ить.
      await this._markSubmissionFailed(input.orderId, `RESERVE_FAILED: ${reserveResult.error.message}`);
      return Err(new TradingError(
        `Failed to reserve ${isBuy ? 'balance' : 'tokens'}: ${reserveResult.error.message}`,
        {
          context: {
            clientOrderId: String(input.orderId),
            ...(isBuy ? { notional: notional!.toString() } : { instrumentId: String(input.instrumentId), size: input.size.value().toString() }),
          },
        },
      ));
    }

    // Шаг 3: Отправка на биржу
    // input.orderId используется как clientOrderId для идемпотентности retry.
    // Фактический orderId ордера = venueOrderId, который вернёт биржа.
    const submitParams: SubmitOrderParams = {
      asset: input.asset,
      side: input.side,
      price: input.price,
      size: input.size,
      postOnly: input.postOnly,
      orderType: input.orderType,
      clientOrderId: String(input.orderId),
      strategyId: input.strategyId,
    };
    const submitResult = await this._deps.exchangeClient.submitOrder(submitParams);

    if (!submitResult.ok) {
      // Транспортная/API ошибка submit. Ключевой вопрос: ДОШЛА ли отправка до
      // venue (мог ли ордер создаться)? Читаем ExchangeError.submitOutcome.
      // Conservative default (поле не задано) — MAY_HAVE_BEEN_SUBMITTED: для
      // live trading безопаснее считать ордер потенциально созданным.
      const submitOutcome = submitResult.error.submitOutcome ?? 'MAY_HAVE_BEEN_SUBMITTED';

      // Откат резервации нужен в обеих ветках (ордер локально не создан).
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            input.size.value(),
          );

      if (submitOutcome === 'MAY_HAVE_BEEN_SUBMITTED') {
        // Ambiguous: venue-ордер МОГ быть создан. Трактуем как UNKNOWN —
        // НЕ создаём обычный Order, создаём SUBMIT_UNKNOWN_OUTCOME issue.
        // venueOrderId у транспортной ошибки обычно нет → cancel невозможен,
        // но факт ambiguity обязан быть queryable для ручной реконсиляции.
        this._logger.error('Exchange submit transport error MAY_HAVE_BEEN_SUBMITTED — venue order may be live, manual reconciliation required', {
          clientOrderId: String(input.orderId),
          error: submitResult.error.message,
        });
        if (!releaseResult.ok) {
          this._logger.error('Failed to release reservation after ambiguous submit error', {
            clientOrderId: String(input.orderId),
            releaseError: releaseResult.error.message,
          });
          await this._addRollbackReleaseIssue({
            releaseError: releaseResult.error.message,
            stage: 'submit-may-have-been-submitted-rollback',
            clientOrderId: input.orderId,
            accountId: input.accountId,
            instrumentId: input.instrumentId,
          });
        }
        await this._addReconciliationIssue({
          id: `reconciliation:submit-client:${String(input.orderId)}:unknown`,
          type: 'SUBMIT_UNKNOWN_OUTCOME',
          status: 'OPEN',
          reason: `SUBMIT_TRANSPORT_MAY_HAVE_BEEN_SUBMITTED: ${submitResult.error.message}`,
          createdAt: this._deps.clock.now(),
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          context: {
            clientOrderId: String(input.orderId),
            submitOutcome,
            cancelAttempted: false,
            rollbackReleaseOk: releaseResult.ok,
          },
        });
        // Submission ambiguous — блокируем авто-retry (begin вернёт UNKNOWN).
        await this._markSubmissionUnknown(input.orderId, `SUBMIT_TRANSPORT_MAY_HAVE_BEEN_SUBMITTED: ${submitResult.error.message}`);
        return Err(new TradingError(
          `Exchange submit transport error (may have been submitted, manual reconciliation): ${submitResult.error.message}`,
          {
            context: {
              clientOrderId: String(input.orderId),
              submitOutcome,
              rollbackError: releaseResult.ok ? undefined : releaseResult.error.message,
            },
          },
        ));
      }

      // DEFINITELY_NOT_SUBMITTED: ордер точно не создан — чистый rollback + Err.
      this._logger.warn('Exchange submit failed (definitely not submitted), rolling back reservation', {
        clientOrderId: String(input.orderId),
        error: submitResult.error.message,
      });
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation during rollback', {
          clientOrderId: String(input.orderId),
          releaseError: releaseResult.error.message,
        });
        await this._addRollbackReleaseIssue({
          releaseError: releaseResult.error.message,
          stage: 'submit-definitely-not-submitted-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
        });
      }
      // Ордер точно не создан — submission можно retry-ить.
      await this._markSubmissionFailed(input.orderId, `SUBMIT_DEFINITELY_NOT_SUBMITTED: ${submitResult.error.message}`);
      return Err(new TradingError(
        `Exchange submission failed: ${submitResult.error.message}`,
        {
          context: {
            clientOrderId: String(input.orderId),
            submitOutcome,
            rollbackError: releaseResult.ok ? undefined : releaseResult.error.message,
          },
        },
      ));
    }

    const submitValue = submitResult.value;

    // REJECTED: venue явно отклонил ордер, live-ордера не существует — откатываем
    // резервацию под ПОЛНЫЙ исходный size (адаптер ничего не отправил на venue-side,
    // корректировать нечего) и не создаём локальный Order.
    if (submitValue.status === 'REJECTED') {
      this._logger.warn('Exchange rejected order (no live order created), rolling back reservation', {
        clientOrderId: String(input.orderId),
        reason: submitValue.reason,
      });
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            input.size.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation after REJECTED submit', {
          clientOrderId: String(input.orderId),
          releaseError: releaseResult.error.message,
        });
        await this._addRollbackReleaseIssue({
          releaseError: releaseResult.error.message,
          stage: 'rejected-submit-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
        });
      }
      // Venue отклонил — live-ордера нет, submission можно retry-ить.
      await this._markSubmissionFailed(input.orderId, `SUBMIT_REJECTED: ${submitValue.reason}`);
      return Err(new TradingError(
        `Exchange rejected order: ${submitValue.reason}`,
        {
          context: {
            clientOrderId: String(input.orderId),
            rollbackError: releaseResult.ok ? undefined : releaseResult.error.message,
          },
        },
      ));
    }

    // UNKNOWN: ответ venue не укладывается в безопасную модель — НЕ создаём обычный
    // OPEN order на основании непонятных данных. Откатываем резервацию; если venue
    // всё же вернул orderId, делаем best-effort cancel (ордер может быть live).
    if (submitValue.status === 'UNKNOWN') {
      this._logger.error('Exchange submit result ambiguous (UNKNOWN) — rolling back, manual reconciliation required', {
        clientOrderId: String(input.orderId),
        reason: submitValue.reason,
        venueOrderId: submitValue.orderId ? String(submitValue.orderId) : undefined,
      });
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            input.size.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation after UNKNOWN submit result', {
          clientOrderId: String(input.orderId),
          releaseError: releaseResult.error.message,
        });
      }
      if (submitValue.orderId) {
        const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(submitValue.orderId);
        await this._handleRollbackCancelOutcome({
          venueOrderId: submitValue.orderId,
          cancelResult: cancelExchangeResult,
          stage: 'unknown-submit-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          transportErrorMessage: 'Failed to cancel exchange order after UNKNOWN submit result — venue order may still be live, manual reconciliation required',
        });
      }
      // Issue создаётся ДАЖЕ если best-effort cancel удался: исход submit был
      // ambiguous — venue-состояние требует ручной проверки в любом случае.
      // Сбой add() не меняет исходный Err ниже.
      await this._addReconciliationIssue({
        id: submitValue.orderId
          ? `reconciliation:submit:${String(submitValue.orderId)}:unknown`
          : `reconciliation:submit-client:${String(input.orderId)}:unknown`,
        type: 'SUBMIT_UNKNOWN_OUTCOME',
        status: 'OPEN',
        reason: submitValue.reason,
        createdAt: this._deps.clock.now(),
        ...(submitValue.orderId ? { orderId: submitValue.orderId } : {}),
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        context: {
          clientOrderId: String(input.orderId),
          ...(submitValue.orderId ? { venueOrderId: String(submitValue.orderId) } : {}),
          cancelAttempted: submitValue.orderId !== undefined,
          rollbackReleaseOk: releaseResult.ok,
        },
      });
      // Submission ambiguous — блокируем авто-retry (begin вернёт UNKNOWN).
      await this._markSubmissionUnknown(input.orderId, `SUBMIT_UNKNOWN: ${submitValue.reason}`, submitValue.orderId);
      return Err(new TradingError(
        `Exchange submit result ambiguous: ${submitValue.reason}`,
        {
          context: {
            clientOrderId: String(input.orderId),
            venueOrderId: submitValue.orderId ? String(submitValue.orderId) : undefined,
          },
        },
      ));
    }

    // Здесь submitValue.status ∈ {OPEN, PARTIALLY_FILLED, FILLED} — все три варианта
    // содержат orderId + effectiveSize; ордер реально создан на venue.
    // venueOrderId — реальный ID от биржи (0xa928...).
    // Именно этот ID используется в WS-событиях (fills, order updates).
    // Order entity создаётся с этим ID, чтобы lookups в OrderUpdateHandler работали.
    const venueOrderId = submitValue.orderId;
    const effectiveSize = submitValue.effectiveSize;

    // Адаптер биржи (например, SELL preflight balance check в
    // PolymarketExchangeClientAdapter) мог скорректировать size перед отправкой.
    // Резервация в Шаге 2 была сделана под input.size — если effectiveSize меньше,
    // нужно освободить излишек ДО создания Order, иначе:
    // 1. Order создастся с неверным (завышенным) size относительно реального ордера на бирже
    // 2. Излишек резервации останется висеть, блокируя баланс/токены без причины
    // `orderSize`/`orderNotional` далее используются вместо `input.size`/`notional` во всех
    // rollback-ветках, чтобы освобождать РОВНО то, что реально осталось зарезервировано.
    //
    // Guard: effectiveSize обязан быть в диапазоне (0, input.size]. Контракт порта
    // (SubmitOrderResult.effectiveSize) документирует именно это, но если реализация
    // adapter'а его нарушит (баг, 0, отрицательное или size БОЛЬШЕ запрошенного) —
    // excessSize стал бы отрицательным, и код попытался бы "освободить" отрицательную
    // резервацию, что незаметно испортит Portfolio. Вместо этого — abort с отменой
    // venue-ордера и Err, а не тихое продолжение.
    if (effectiveSize.isZero() || effectiveSize.isGreaterThan(input.size)) {
      this._logger.error('Exchange returned invalid effectiveSize — aborting and cancelling venue order', {
        venueOrderId: String(venueOrderId),
        requestedSize: input.size.value().toString(),
        effectiveSize: effectiveSize.value().toString(),
      });
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            input.size.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation after invalid effectiveSize — manual reconciliation required', {
          venueOrderId: String(venueOrderId),
          releaseError: releaseResult.error.message,
        });
        await this._addRollbackReleaseIssue({
          releaseError: releaseResult.error.message,
          stage: 'invalid-effective-size-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          venueOrderId,
        });
      }
      const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
      await this._handleRollbackCancelOutcome({
        venueOrderId,
        cancelResult: cancelExchangeResult,
        stage: 'invalid-effective-size-rollback',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        transportErrorMessage: 'Failed to cancel exchange order after invalid effectiveSize — venue order may still be live, manual reconciliation required',
      });
      // Venue-ордер был создан и мы попытались его отменить (best-effort) —
      // ambiguous: блокируем авто-retry.
      await this._markSubmissionUnknown(input.orderId, 'ROLLBACK_INVALID_EFFECTIVE_SIZE', venueOrderId);
      return Err(new TradingError(
        `Exchange returned invalid effectiveSize (${effectiveSize.value().toString()}) for requested size (${input.size.value().toString()})`,
        { context: { venueOrderId: String(venueOrderId) } },
      ));
    }

    let orderSize = input.size;
    let orderNotional = notional;
    if (!effectiveSize.equals(input.size)) {
      const excessSize = input.size.value().minus(effectiveSize.value());
      this._logger.warn('Exchange adjusted order size — releasing excess reservation', {
        venueOrderId: String(venueOrderId),
        requestedSize: input.size.value().toString(),
        effectiveSize: effectiveSize.value().toString(),
      });

      const excessReleaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(
            input.accountId,
            input.price.value().times(excessSize),
          )
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            excessSize,
          );
      if (!excessReleaseResult.ok) {
        // Не продолжаем как ни в чём не бывало: если излишек не освободился, Portfolio
        // и venue разойдутся молча (order сохранится с меньшим size, а лишняя резервация
        // останется висеть). Отменяем venue-ордер и требуем ручной reconciliation вместо
        // сохранения Order с потенциально неверным состоянием резервации.
        this._logger.error('Failed to release excess reservation after size adjustment — aborting, manual reconciliation required', {
          venueOrderId: String(venueOrderId),
          releaseError: excessReleaseResult.error.message,
        });
        await this._addRollbackReleaseIssue({
          releaseError: excessReleaseResult.error.message,
          stage: 'excess-release-failure-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          venueOrderId,
        });
        const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
        await this._handleRollbackCancelOutcome({
          venueOrderId,
          cancelResult: cancelExchangeResult,
          stage: 'excess-release-failure-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          transportErrorMessage: 'Failed to cancel exchange order after excess-release failure — venue order may still be live, manual reconciliation required',
        });
        await this._markSubmissionUnknown(input.orderId, 'ROLLBACK_EXCESS_RELEASE_FAILURE', venueOrderId);
        return Err(new TradingError(
          `Failed to release excess reservation after exchange size adjustment: ${excessReleaseResult.error.message}`,
          { context: { venueOrderId: String(venueOrderId) } },
        ));
      }

      orderSize = effectiveSize;
      orderNotional = isBuy ? input.price.value().times(effectiveSize.value()) : undefined;
    }

    // Шаг 4: Создание Order aggregate с venueOrderId
    const timestampResult = TimestampService.fromDate(this._deps.clock.now());
    if (!timestampResult.ok) {
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, orderNotional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            orderSize.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation after timestamp failure', {
          venueOrderId: String(venueOrderId),
          releaseError: releaseResult.error.message,
        });
        await this._addRollbackReleaseIssue({
          releaseError: releaseResult.error.message,
          stage: 'timestamp-failure-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          venueOrderId,
        });
      }
      const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
      await this._handleRollbackCancelOutcome({
        venueOrderId,
        cancelResult: cancelExchangeResult,
        stage: 'timestamp-failure-rollback',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        transportErrorMessage: 'Failed to cancel exchange order after timestamp failure — venue order may still be live, manual reconciliation required',
      });
      await this._markSubmissionUnknown(input.orderId, 'ROLLBACK_TIMESTAMP_FAILURE', venueOrderId);
      return Err(new TradingError(
        `Failed to create timestamp: ${timestampResult.error.message}`,
        { context: { venueOrderId: String(venueOrderId) } },
      ));
    }

    const orderResult = Order.create({
      id: venueOrderId,
      asset: input.asset,
      side: input.side,
      price: input.price,
      size: orderSize,
      timestamp: timestampResult.value,
      strategyId: input.strategyId,
    });
    if (!orderResult.ok) {
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, orderNotional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            orderSize.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation after Order.create failure', {
          venueOrderId: String(venueOrderId),
          releaseError: releaseResult.error.message,
        });
        await this._addRollbackReleaseIssue({
          releaseError: releaseResult.error.message,
          stage: 'order-create-failure-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          venueOrderId,
        });
      }
      const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
      await this._handleRollbackCancelOutcome({
        venueOrderId,
        cancelResult: cancelExchangeResult,
        stage: 'order-create-failure-rollback',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        transportErrorMessage: 'Failed to cancel exchange order after Order.create failure — venue order may still be live, manual reconciliation required',
      });
      await this._markSubmissionUnknown(input.orderId, 'ROLLBACK_ORDER_CREATE_FAILURE', venueOrderId);
      return Err(orderResult.error);
    }
    const order = orderResult.value;

    // Шаг 5: Принятие ордера (PENDING → OPEN)
    const acceptResult = order.accept();
    if (!acceptResult.ok) {
      // Откат: снять резервацию и отменить ордер на бирже
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, orderNotional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            orderSize.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation during accept() rollback', {
          venueOrderId: String(venueOrderId),
          releaseError: releaseResult.error.message,
        });
        await this._addRollbackReleaseIssue({
          releaseError: releaseResult.error.message,
          stage: 'accept-failure-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          venueOrderId,
        });
      }
      const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
      await this._handleRollbackCancelOutcome({
        venueOrderId,
        cancelResult: cancelExchangeResult,
        stage: 'accept-failure-rollback',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        transportErrorMessage: 'Failed to cancel exchange order during accept() rollback',
      });
      await this._markSubmissionUnknown(input.orderId, 'ROLLBACK_ACCEPT_FAILURE', venueOrderId);
      return Err(acceptResult.error);
    }
    const acceptedOrder = acceptResult.value;

    // Шаг 6: Сохранение ордера (с venueOrderId).
    // Новый ордер → expectedVersion=0 (CAS). Конфликт означает, что под этим
    // venueOrderId в репозитории уже есть запись (гонка с reconcile/WS-обработкой) —
    // молча перетирать её нельзя.
    const saveResult = await this._deps.orderRepo.save(acceptedOrder, 0);
    if (!saveResult.ok) {
      this._logger.error('Failed to save accepted order due to version conflict', {
        venueOrderId: String(venueOrderId),
        expected: saveResult.error.expected,
        actual: saveResult.error.actual,
      });
      // Submission guard: если конфликт вызван НАШИМ же предыдущим committed
      // submit того же clientOrderId (retry получил тот же venueOrderId) —
      // НЕ отменяем venue-ордер (иначе отменили бы успешно созданный) и не
      // трогаем резервацию; возвращаем существующий venueOrderId.
      if (this._deps.submissions) {
        const prior = await this._deps.submissions.get(input.orderId);
        if (prior && prior.status === 'COMMITTED' && prior.venueOrderId && String(prior.venueOrderId) === String(venueOrderId)) {
          this._logger.warn('Save conflict matches own committed submission — skipping rollback cancel, returning existing venueOrderId', {
            clientOrderId: String(input.orderId),
            venueOrderId: String(venueOrderId),
          });
          return Ok({ venueOrderId });
        }
      }
      // Ордер уже создан на venue — best-effort отмена, как в других rollback-ветках.
      const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
      await this._handleRollbackCancelOutcome({
        venueOrderId,
        cancelResult: cancelExchangeResult,
        stage: 'save-conflict-rollback',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        transportErrorMessage: 'Failed to cancel exchange order after save conflict — venue order may still be live, manual reconciliation required',
      });
      // Откат резервации (она ещё не освобождалась в этой ветке).
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, orderNotional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            orderSize.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation after save conflict — manual reconciliation required', {
          venueOrderId: String(venueOrderId),
          releaseError: releaseResult.error.message,
        });
        await this._addRollbackReleaseIssue({
          releaseError: releaseResult.error.message,
          stage: 'save-conflict-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          venueOrderId,
        });
      }
      // Конфликт НЕ от нашего committed submit (чужая запись под venueOrderId) —
      // venue-ордер мог остаться live после best-effort cancel: ambiguous.
      await this._markSubmissionUnknown(input.orderId, 'ROLLBACK_SAVE_CONFLICT', venueOrderId);
      // События НЕ публикуем — локально ордер не сохранён.
      return Err(new TradingError(
        `Failed to save order due to version conflict: ${saveResult.error.message}`,
        { context: { venueOrderId: String(venueOrderId) } },
      ));
    }

    // Order сохранён локально — фиксируем committed submission (guard от
    // небезопасного повторного submit того же clientOrderId).
    if (this._deps.submissions) {
      try {
        await this._deps.submissions.markCommitted(input.orderId, venueOrderId, this._deps.clock.now());
      } catch (err) {
        this._logger.error('Failed to mark submission COMMITTED', {
          clientOrderId: String(input.orderId),
          venueOrderId: String(venueOrderId),
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    // PARTIALLY_FILLED/FILLED: часть или весь ордер уже исполнен на venue в момент
    // submit-ответа. Помечаем через pendingMatchFillId СРАЗУ после успешного CAS save
    // и ДО publishAll() — иначе OrderEventBridge/стратегия увидят ORDER_ACCEPTED
    // раньше marker'а и могут успеть попытаться cancel/reprice OPEN-ордер, который
    // на самом деле уже (частично) исполнен. Реальный Fill придёт отдельно через
    // WS (FillEventHandler) или REST (ReconcileTradesUseCase); мы НЕ синтезируем
    // Fill здесь и НЕ применяем его к Portfolio на этом уровне.
    const filledOnSubmit = submitValue.status === 'PARTIALLY_FILLED' || submitValue.status === 'FILLED';
    if (filledOnSubmit) {
      this._deps.orderStateStore.markOrderFillMatched(venueOrderId, pendingMatchFillId(venueOrderId));
      this._logger.warn('Order partially/fully filled on exchange — awaiting fill via WS/reconciliation', {
        venueOrderId: String(venueOrderId),
        submitStatus: submitValue.status,
        side: input.side,
        price: input.price.value().toString(),
        size: orderSize.value().toString(),
      });
    }

    // FILLED: live-ордера на venue уже НЕТ, а Portfolio нельзя обновить без
    // реальных fill details (мы их не синтезируем) — создаём queryable issue,
    // чтобы отсутствие WS/reconciliation fill было видимо и alertable.
    // Строго ПОСЛЕ успешного save + marker и ДО publishAll: если publishAll
    // упадёт, issue уже записана. Сбой add() логируется и не ломает успешный
    // результат use case.
    // Для PARTIALLY_FILLED issue НЕ создаётся: ордер всё ещё live, pending
    // marker (markOrderFillMatched выше) достаточен — остаток ордера виден
    // venue-стороне и придёт обычным путём.
    if (submitValue.status === 'FILLED') {
      await this._addReconciliationIssue({
        id: `reconciliation:submit:${String(venueOrderId)}:filled-without-fill-details`,
        type: 'SUBMIT_FILLED_WITHOUT_FILL_DETAILS',
        status: 'OPEN',
        reason: 'Submit returned FILLED without fill details; waiting for WS/reconciliation fill',
        createdAt: this._deps.clock.now(),
        orderId: venueOrderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        context: {
          clientOrderId: String(input.orderId),
          filledSize: submitValue.filledSize.value().toString(),
          effectiveSize: effectiveSize.value().toString(),
          side: input.side,
          price: input.price.value().toString(),
        },
      });
    }

    // Шаг 7: Публикация событий — ВНУТРИ lock (после save + markers + issues).
    // Бизнес-коммит уже состоялся (CAS save, ордер live на venue) — публикация
    // это notification path, НЕ часть транзакции. Держим её под lock, чтобы
    // конкурентный Fill (ждущий тот же mutex) не смог опубликовать ORDER_FILLED
    // раньше ORDER_CREATED/ORDER_ACCEPTED — иначе стратегия/bridge увидели бы
    // события этого ордера в неверном порядке.
    // Ошибка publish НЕ откатывает состояние и НЕ делает committed operation
    // retryable (повторный execute() создал бы дубль на venue): логируем
    // EVENT_PUBLISH_FAILED, создаём queryable issue для ручного replay и
    // возвращаем Ok(venueOrderId).
    const events = acceptedOrder.pullEvents();
    try {
      await this._deps.eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('EVENT_PUBLISH_FAILED: Failed to publish order placed events after commit — order stays placed, event lost', {
        venueOrderId: String(venueOrderId),
        clientOrderId: String(input.orderId),
        submitStatus: submitValue.status,
        err: err instanceof Error ? err : new Error(message),
      });
      await this._addReconciliationIssue({
        id: `reconciliation:submit:${String(venueOrderId)}:event-publish-failed`,
        type: 'EVENT_PUBLISH_FAILED',
        status: 'OPEN',
        reason: `EVENT_PUBLISH_FAILED: order placed but ORDER_CREATED/ORDER_ACCEPTED not published: ${message}`,
        createdAt: this._deps.clock.now(),
        orderId: venueOrderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        context: {
          stage: 'publish-after-place-commit',
          clientOrderId: String(input.orderId),
          submitStatus: submitValue.status,
        },
      });
      return Ok({ venueOrderId });
    }

    this._logger.info('Order placed successfully', {
      venueOrderId: String(venueOrderId),
      clientOrderId: String(input.orderId),
      side: input.side,
      submitStatus: submitValue.status,
      ...(orderNotional !== undefined ? { notional: orderNotional.toString() } : { size: orderSize.value().toString() }),
    });

    return Ok({ venueOrderId });
  }
}
