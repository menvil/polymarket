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
 * 7. Доменные события ENQUEUE-ятся в `orderedEventOutbox` ВНУТРИ lock (после
 *    save+markers+issues), а публикуются (`flush`) уже ПОСЛЕ выхода из lock (в
 *    `execute()`). Это исключает deadlock (handler ORDER_ACCEPTED, вызывающий
 *    lock-зависимый use-case), а per-order порядок сохраняет сам outbox (FIFO по
 *    aggregateId=venueOrderId): конкурентный Fill enqueue-ит `ORDER_FILLED` в ту
 *    же очередь ПОЗЖЕ, поэтому он не опубликуется раньше `ORDER_CREATED`/
 *    `ORDER_ACCEPTED`. Публикация после успешного commit — notification path, НЕ
 *    часть транзакции: её сбой на flush проглатывается outbox'ом (лог
 *    `EVENT_PUBLISH_FAILED` + queryable `EVENT_PUBLISH_FAILED` issue для ручного
 *    replay), а `execute()` возвращает `Ok(venueOrderId)` (state не откатывается;
 *    Err сделал бы committed operation retryable — повторный вызов создал бы
 *    дублирующий ордер на venue).
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

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { MessageMetadataGenerator } from '@polymarket/messages';
import { TimestampService, Money, Quantity } from '@polymarket/value-objects';
import type { Price, Side } from '@polymarket/value-objects';
import type { AccountId, AssetId, InstrumentId, OrderId, StrategyId } from '@polymarket/ids';
import { accountIdToString, assetIdToString } from '@polymarket/ids';
import type {
  IExchangeClient,
  IKeyedMutex,
  IMarketCatalog,
  IOrderedEventOutbox,
  IOrderRepository,
  IOrderStateStore,
  IOrderSubmissionRepository,
  IReconciliationIssueRepository,
  ReconciliationIssue,
  SubmitOrderParams,
} from '@polymarket/ports';
import { pendingMatchFillId, ExchangeError } from '@polymarket/ports';
import { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import type { IOrderRiskChecker } from '@polymarket/risk';
import { RiskViolationError } from '@polymarket/risk';
import type { PortfolioService } from './services/PortfolioService.js';
import { PlaceOrderFailureError } from './PlaceOrderFailure.js';
import { enqueueCommittedEvents } from './services/enqueueCommittedEvents.js';
import { lockKey } from './lockKeys.js';

/**
 * Защищённая сериализация AssetId для submission record.
 *
 * @param asset - AssetId (union-объект либо legacy string-представление)
 * @returns Сериализованная строка либо `undefined`, если сериализация невозможна
 */
function safeAssetId(asset: AssetId): string | undefined {
  if (typeof asset === 'string') return asset;
  try {
    return assetIdToString(asset);
  } catch {
    return undefined;
  }
}

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
  /** ID стратегии (опционально) — canonical branded StrategyId */
  readonly strategyId?: StrategyId;
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
  /**
   * Ordered event outbox для доменных событий Order lifecycle.
   *
   * @remarks
   * Под lock события только `enqueue`-ятся (per-aggregate FIFO), а публикация
   * (`flush`) выполняется уже ПОСЛЕ выхода из lock — это исключает deadlock
   * (handler ORDER_ACCEPTED, вызывающий lock-зависимый use-case) и сохраняет
   * per-order порядок (Fill не опубликует ORDER_FILLED раньше ORDER_CREATED).
   */
  readonly orderedEventOutbox: IOrderedEventOutbox;
  /**
   * Canonical-генератор metadata порождаемых Order-событий (M-003).
   * Place — инициативная команда (стратегия/оператор), поэтому события — root.
   */
  readonly metadataGenerator: MessageMetadataGenerator;
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
   * Submission guard по clientOrderId (ОБЯЗАТЕЛЬНЫЙ).
   *
   * @remarks
   * Защищает от небезопасного повторного submit: повторный `execute()` с тем же
   * `input.orderId` после committed submit возвращает существующий venueOrderId
   * БЕЗ повторного submit и БЕЗ rollback cancel; save-conflict с уже committed
   * submission не отменяет venue-ордер; ambiguous submit блокирует авто-retry;
   * fingerprint mismatch блокирует переиспользование clientOrderId под другой
   * ордер. Вызывается ВНУТРИ keyed mutex (см. `_placeLocked`).
   *
   * Также источник authoritative pending BUY-экспозиции по инструменту
   * (`getPendingBuyQuantityForInstrument`) для `maxPositionSize`-проверки.
   */
  readonly submissions: IOrderSubmissionRepository;
  /**
   * Каталог инструментов (опционально) — источник `expiresAt` для expiry-gate.
   *
   * @remarks
   * `timeToExpiryMs` вычисляется как `instrument.expiresAt.toNumber() -
   * clock.now().getTime()` и передаётся в риск-чекер (пересчитывается отдельно
   * для precheck и authoritative-проверки под lock — время идёт).
   *
   * Fail-closed: если каталог не передан ИЛИ инструмент в нём отсутствует,
   * `timeToExpiryMs` = `undefined`. При включённом `minTimeToExpiryMs` риск-чекер
   * вернёт `RISK_INPUT_INCOMPLETE` для BUY (SELL не блокируется). В production
   * каталог ОБЯЗАН быть передан; optional — чтобы не ломать конструкторы/тесты,
   * где expiry-лимит не используется.
   */
  readonly marketCatalog?: IMarketCatalog;
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
   * Вычисляет время до экспирации инструмента (ms) на текущий момент часов.
   *
   * @param instrumentId - ID инструмента
   * @returns `timeToExpiryMs` = `expiresAt - now`, либо `undefined`, если каталог
   *   не передан ИЛИ инструмент в нём отсутствует (fail-closed на стороне
   *   риск-чекера: BUY при включённом лимите → `RISK_INPUT_INCOMPLETE`)
   *
   * @remarks
   * Читает `clock.now()` при каждом вызове — поэтому precheck (вне lock) и
   * authoritative-проверка (под lock) получают АКТУАЛЬНОЕ значение (между ними
   * прошло время ожидания lock и network call). Отрицательный результат означает
   * уже истёкший рынок.
   */
  private _computeTimeToExpiryMs(instrumentId: InstrumentId): number | undefined {
    const info = this._deps.marketCatalog?.get(instrumentId);
    if (!info) return undefined;
    return info.expiresAt.toNumber() - this._deps.clock.now().getTime();
  }

  /**
   * Помечает submission как FAILED (retry допустим) — best-effort, no-op без repo.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param reason - Причина
   */
  private async _markSubmissionFailed(clientOrderId: OrderId, reason: string): Promise<void> {
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
   * Помечает резервацию held в execution journal — COMMIT-CRITICAL.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param initial - Зарезервированное количество (decimal-строка)
   * @returns Ok(void) при успехе; Err с сообщением при сбое (Result или throw)
   *
   * @remarks
   * Вызывается СРАЗУ после успешного `PortfolioService.reserve...` и ДО
   * `submitOrder`. Сбой журнала теперь НЕ best-effort: caller ОБЯЗАН прервать
   * submit и компенсирующе освободить Portfolio-резервацию (см. `_placeLocked`,
   * шаг 2) — иначе Fill-recovery по журналу не нашёл бы held-резервацию, а
   * retry мог бы заморозить капитал дважды.
   */
  private async _markReservationHeldCritical(
    clientOrderId: OrderId,
    initial: string,
  ): Promise<Result<void, TradingError>> {
    try {
      const r = await this._deps.submissions.markReservationHeld(clientOrderId, initial, this._deps.clock.now());
      if (!r.ok) {
        return Err(new TradingError(
          `Failed to mark reservation HELD in execution journal: ${r.error.message}`,
          { context: { clientOrderId: String(clientOrderId), initial } },
        ));
      }
      return Ok(undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(new TradingError(
        `Failed to mark reservation HELD in execution journal (threw): ${message}`,
        { context: { clientOrderId: String(clientOrderId), initial } },
      ));
    }
  }

  /**
   * Переводит резервацию в журнале в RECONCILIATION_REQUIRED — best-effort.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param operationId - Attempt-scoped operationId (идемпотентность)
   *
   * @remarks
   * Используется, когда Portfolio release упал: журнал НЕЛЬЗЯ переводить в
   * SETTLED (капитал может остаться замороженным), фиксируем неоднозначность.
   * Сбой самого перевода логируется (журнал и так не в SETTLED — retry всё
   * равно заблокирован submission-статусом).
   */
  private async _markJournalReconciliationRequired(clientOrderId: OrderId, operationId: string): Promise<void> {
    try {
      const r = await this._deps.submissions.applyReservationTransition(clientOrderId, {
        operationId,
        status: 'RECONCILIATION_REQUIRED',
        now: this._deps.clock.now(),
      });
      if (!r.ok) {
        this._logger.error('Failed to mark reservation journal RECONCILIATION_REQUIRED', {
          clientOrderId: String(clientOrderId),
          operationId,
          error: r.error.message,
        });
      }
    } catch (err) {
      this._logger.error('Failed to mark reservation journal RECONCILIATION_REQUIRED (threw)', {
        clientOrderId: String(clientOrderId),
        operationId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Подтверждённый rollback резервации ДО retry (venue-ордера гарантированно НЕТ).
   *
   * @param args - `input`, `attempt`, `rollbackSlug` (definitely-not-submitted/
   *   rejected), `reservationInitial`, `releaseReservation` (closure Portfolio
   *   release), `failReason` (для markFailed), `stage` (для issue)
   * @returns `releaseError` — сообщение ошибки Portfolio release (для context Err)
   *
   * @remarks
   * ### Главный инвариант:
   * `markFailed` (→ retry разрешён) вызывается ТОЛЬКО после подтверждённого
   * Portfolio release И подтверждённого journal release (`remaining === 0`,
   * `status === 'SETTLED'`).
   *
   * Алгоритм:
   * 1. Portfolio release.
   * 2. Если release упал: journal НЕ переводится в SETTLED — помечается
   *    `RECONCILIATION_REQUIRED` (если repo доступен), создаётся
   *    `ORDER_PORTFOLIO_DESYNC` issue, submission НЕ помечается FAILED
   *    (остаётся SUBMITTING → begin вернёт IN_PROGRESS, retry заблокирован).
   * 3. Если release успешен: journal release (attempt-scoped operationId),
   *    проверка `remaining === 0 && status === 'SETTLED'` — только после этого
   *    `markFailed()` (retry безопасен). При сбое journal — issue, БЕЗ markFailed.
   */
  private async _releaseReservationBeforeRetry(args: {
    readonly input: PlaceOrderInput;
    readonly attempt: number;
    readonly rollbackSlug: 'definitely-not-submitted' | 'rejected';
    readonly reservationInitial: string;
    readonly releaseReservation: () => ReturnType<PortfolioService['releaseReservation']>;
    readonly failReason: string;
    readonly stage: string;
  }): Promise<{ readonly releaseError?: string }> {
    const { input, attempt, rollbackSlug } = args;
    const operationId = `attempt:${attempt}:rollback:${rollbackSlug}`;

    // Шаг 1: Portfolio release.
    const releaseResult = args.releaseReservation();
    if (!releaseResult.ok) {
      // Шаг 2: release упал — journal НЕ SETTLED, RECONCILIATION_REQUIRED,
      // submission остаётся SUBMITTING (blocking, НЕ markFailed) + manual block
      // на инструмент (issue сама торговлю не блокирует).
      this._logger.error('Failed to release reservation during rollback — submission blocked, manual reconciliation required', {
        clientOrderId: String(input.orderId),
        stage: args.stage,
        releaseError: releaseResult.error.message,
      });
      await this._markJournalReconciliationRequired(input.orderId, `${operationId}:release-failed`);
      this._deps.orderStateStore.markManualReconciliationBlock({
        orderId: input.orderId,
        instrumentId: input.instrumentId,
        reason: `PLACE_ROLLBACK_RELEASE_FAILED (${args.stage}): ${releaseResult.error.message}`,
      });
      await this._addRollbackReleaseIssue({
        releaseError: releaseResult.error.message,
        stage: args.stage,
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
      });
      return { releaseError: releaseResult.error.message };
    }

    // Шаг 3: Portfolio release подтверждён → journal release; markFailed ТОЛЬКО
    // после подтверждённого journal rollback (remaining === 0, SETTLED).
    let journalSettled = false;
    let journalError: string | undefined;
    try {
      const r = await this._deps.submissions.applyReservationTransition(input.orderId, {
        operationId,
        release: args.reservationInitial,
        now: this._deps.clock.now(),
      });
      if (r.ok) {
        const res = r.value.reservation;
        journalSettled = res.status === 'SETTLED' && new Decimal(res.remaining).isZero();
        if (!journalSettled) {
          journalError = `journal not settled after rollback release: status=${res.status} remaining=${res.remaining}`;
        }
      } else {
        journalError = r.error.message;
      }
    } catch (err) {
      journalError = err instanceof Error ? err.message : String(err);
    }

    if (!journalSettled) {
      // Journal НЕ settled при уже освобождённом Portfolio — desync: best-effort
      // RECONCILIATION_REQUIRED + manual block (задержанный fill не должен
      // выбрать held-path на уже освобождённый капитал).
      this._logger.error('Reservation journal rollback release failed — submission blocked (markFailed skipped), manual reconciliation required', {
        clientOrderId: String(input.orderId),
        stage: args.stage,
        operationId,
        error: journalError,
      });
      await this._markJournalReconciliationRequired(input.orderId, `${operationId}:journal-release-failed`);
      this._deps.orderStateStore.markManualReconciliationBlock({
        orderId: input.orderId,
        instrumentId: input.instrumentId,
        reason: `PLACE_ROLLBACK_JOURNAL_RELEASE_FAILED (${args.stage}): ${journalError}`,
      });
      await this._addReconciliationIssue({
        id: `reconciliation:place-rollback-client:${String(input.orderId)}:journal-release-failed`,
        type: 'RESERVATION_JOURNAL_DESYNC',
        status: 'OPEN',
        reason: `PLACE_ROLLBACK_JOURNAL_RELEASE_FAILED: ${journalError}`,
        createdAt: this._deps.clock.now(),
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        context: { stage: args.stage, clientOrderId: String(input.orderId), operationId },
      });
      return {};
    }

    // Portfolio + journal rollback подтверждены → retry безопасен.
    await this._markSubmissionFailed(input.orderId, args.failReason);
    return {};
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
   * markCommitted с обработкой сбоя как critical partial commit.
   *
   * @param clientOrderId - Клиентский ID ордера
   * @param venueOrderId - venue orderId
   *
   * @remarks
   * Order уже сохранён локально к моменту вызова. Сбой `markCommitted` — это
   * рассинхрон submission-repo и Order-repo: guard не узнает, что ордер committed,
   * и при retry мог бы повторно отменить его. НЕ просто лог: создаётся
   * `VENUE_LOCAL_ORDER_DESYNC` issue (blocking/critical). Business state committed,
   * поэтому caller возвращает Ok — retry submit не нужен.
   */
  private async _safeMarkCommitted(input: PlaceOrderInput, venueOrderId: OrderId): Promise<void> {
    try {
      await this._deps.submissions.markCommitted(input.orderId, venueOrderId, this._deps.clock.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('SUBMISSION_REPOSITORY_DESYNC: markCommitted failed after Order saved — guard/order desync, manual reconciliation required', {
        clientOrderId: String(input.orderId),
        venueOrderId: String(venueOrderId),
        error: message,
      });
      await this._addReconciliationIssue({
        id: `reconciliation:submit:${String(venueOrderId)}:submission-mark-committed-failed`,
        type: 'VENUE_LOCAL_ORDER_DESYNC',
        status: 'OPEN',
        reason: `SUBMISSION_REPOSITORY_DESYNC: markCommitted failed after Order saved: ${message}`,
        createdAt: this._deps.clock.now(),
        orderId: venueOrderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        context: { stage: 'mark-committed-after-save', clientOrderId: String(input.orderId) },
      });
    }
  }

  /**
   * Строит детерминированный fingerprint параметров ордера.
   *
   * @param input - Входные данные ордера
   * @returns Стабильная строка из всех trade-defining полей
   *
   * @remarks
   * Используется submission guard: если `clientOrderId` переиспользован под
   * ДРУГИЕ параметры (side/price/size/…), begin() вернёт `FINGERPRINT_MISMATCH`,
   * и мы НЕ вернём чужой venueOrderId по ALREADY_COMMITTED. Стабильный
   * JSON-порядок полей (не `JSON.stringify` объекта) — без crypto.
   */
  private _buildFingerprint(input: PlaceOrderInput): string {
    return [
      `account=${accountIdToString(input.accountId)}`,
      `instrument=${String(input.instrumentId)}`,
      `asset=${String(input.asset)}`,
      `side=${input.side}`,
      `price=${input.price.value().toString()}`,
      `size=${input.size.value().toString()}`,
      `orderType=${input.orderType ?? ''}`,
      `postOnly=${input.postOnly ?? false}`,
      `strategyId=${input.strategyId ?? ''}`,
    ].join('|');
  }

  /**
   * Политика reservation release при post-submit rollback: release ТОЛЬКО после
   * подтверждённого cancel (CANCELLED/ALREADY_CANCELLED). Иначе venue-ордер мог
   * остаться live/исполниться — размораживать резервацию опасно.
   *
   * @param args - `venueOrderId`, результат `cancelOrder()`, `stage`,
   *   `clientOrderId`, `accountId`, `instrumentId`, `transportErrorMessage`
   * @returns `shouldReleaseReservation` (можно ли безопасно освободить) +
   *   `cancelOutcome` (для лога/context)
   *
   * @remarks
   * Создаёт reconciliation issue для ambiguous исходов (best-effort). При
   * `ALREADY_FILLED` ставит pending in-flight marker (fill придёт на
   * несуществующий локально ордер). Для остальных неоднозначных исходов
   * (transport error / UNKNOWN_RETRY_NEEDED / NOT_FOUND) ставится тот же
   * instrument-block marker: venue-ордер мог остаться live/исполниться —
   * новые торговые операции на инструменте блокируются до reconciliation
   * (инвариант: частично закоммиченное состояние блокирует торговлю).
   */
  private async _cancelVenueOrderBeforeReservationRelease(args: {
    readonly venueOrderId: OrderId;
    readonly cancelResult: Awaited<ReturnType<IExchangeClient['cancelOrder']>>;
    readonly stage: string;
    readonly clientOrderId: OrderId;
    readonly accountId: AccountId;
    readonly instrumentId: InstrumentId;
    readonly transportErrorMessage: string;
  }): Promise<{ readonly shouldReleaseReservation: boolean; readonly cancelOutcome: string }> {
    const { venueOrderId, cancelResult, stage, clientOrderId, accountId, instrumentId } = args;
    const baseContext = { stage, clientOrderId: String(clientOrderId), localOrderSaved: false };

    // Блокирующий instrument-marker для неоднозначных исходов: venue-ордер мог
    // остаться live/исполниться, резервация held — новые операции на инструменте
    // блокируются (hasUnsettledFills) до реального fill/reconciliation.
    const markUncertainBlock = (): void => {
      const pendingFillId = pendingMatchFillId(venueOrderId);
      this._deps.orderStateStore.markOrderFillMatched(venueOrderId, pendingFillId);
      this._deps.orderStateStore.markInFlightFill({
        instrumentId,
        fillId: pendingFillId,
        orderId: venueOrderId,
        status: 'MATCHED',
      });
    };

    if (!cancelResult.ok) {
      this._logger.error(args.transportErrorMessage, {
        venueOrderId: String(venueOrderId),
        error: cancelResult.error.message,
      });
      markUncertainBlock();
      await this._addReconciliationIssue({
        id: `reconciliation:place-rollback:${String(venueOrderId)}:transport-error`,
        type: 'CANCEL_UNKNOWN_OUTCOME',
        status: 'OPEN',
        reason: `ROLLBACK_CANCEL_TRANSPORT_ERROR: ${cancelResult.error.message}`,
        createdAt: this._deps.clock.now(),
        orderId: venueOrderId,
        accountId,
        instrumentId,
        context: { ...baseContext, rollbackCancelOutcome: 'TRANSPORT_ERROR', reservationHeld: true },
      });
      return { shouldReleaseReservation: false, cancelOutcome: 'TRANSPORT_ERROR' };
    }

    const status = cancelResult.value.status;
    switch (status) {
      case 'CANCELLED':
      case 'ALREADY_CANCELLED':
        // Venue подтвердил, что ордер снят — резервацию можно безопасно освободить.
        return { shouldReleaseReservation: true, cancelOutcome: status };
      case 'ALREADY_FILLED': {
        this._logger.error(
          'Rollback cancel failed — order already filled on exchange, reservation held, fill expected',
          { venueOrderId: String(venueOrderId), reason: (cancelResult.value as { reason?: string }).reason },
        );
        // Pending in-flight marker: fill придёт на локально несохранённый ордер —
        // блокируем открытие нового ордера на инструменте до реального fill.
        markUncertainBlock();
        await this._addReconciliationIssue({
          id: `reconciliation:place-rollback:${String(venueOrderId)}:already-filled`,
          type: 'VENUE_LOCAL_ORDER_DESYNC',
          status: 'OPEN',
          reason: `ROLLBACK_CANCEL_ALREADY_FILLED: ${(cancelResult.value as { reason?: string }).reason ?? 'already filled'}`,
          createdAt: this._deps.clock.now(),
          orderId: venueOrderId,
          accountId,
          instrumentId,
          context: { ...baseContext, rollbackCancelOutcome: 'ALREADY_FILLED', reservationHeld: true },
        });
        return { shouldReleaseReservation: false, cancelOutcome: 'ALREADY_FILLED' };
      }
      case 'UNKNOWN_RETRY_NEEDED':
        this._logger.error(
          'Rollback cancel outcome unclear — venue order may still be live, reservation held, manual reconciliation required',
          { venueOrderId: String(venueOrderId), reason: cancelResult.value.reason },
        );
        markUncertainBlock();
        await this._addReconciliationIssue({
          id: `reconciliation:place-rollback:${String(venueOrderId)}:unknown`,
          type: 'CANCEL_UNKNOWN_OUTCOME',
          status: 'OPEN',
          reason: `ROLLBACK_CANCEL_UNKNOWN_OUTCOME: ${cancelResult.value.reason}`,
          createdAt: this._deps.clock.now(),
          orderId: venueOrderId,
          accountId,
          instrumentId,
          context: { ...baseContext, rollbackCancelOutcome: 'UNKNOWN_RETRY_NEEDED', reservationHeld: true },
        });
        return { shouldReleaseReservation: false, cancelOutcome: 'UNKNOWN_RETRY_NEEDED' };
      case 'NOT_FOUND':
        // NOT_FOUND НЕ доказывает отсутствие fill: ордер мог исполниться и уйти
        // из open orders. Резервацию НЕ освобождаем, требуем реконсиляции.
        this._logger.error(
          'Rollback cancel NOT_FOUND — order may have filled and left open orders, reservation held, manual reconciliation required',
          { venueOrderId: String(venueOrderId), reason: (cancelResult.value as { reason?: string }).reason },
        );
        markUncertainBlock();
        await this._addReconciliationIssue({
          id: `reconciliation:place-rollback:${String(venueOrderId)}:not-found`,
          type: 'CANCEL_UNKNOWN_OUTCOME',
          status: 'OPEN',
          reason: `ROLLBACK_CANCEL_NOT_FOUND_REQUIRES_RECONCILIATION: ${(cancelResult.value as { reason?: string }).reason ?? 'not found'}`,
          createdAt: this._deps.clock.now(),
          orderId: venueOrderId,
          accountId,
          instrumentId,
          context: { ...baseContext, rollbackCancelOutcome: 'NOT_FOUND', reservationHeld: true },
        });
        return { shouldReleaseReservation: false, cancelOutcome: 'NOT_FOUND' };
      default: {
        const _exhaustive: never = status;
        return { shouldReleaseReservation: false, cancelOutcome: String(_exhaustive) };
      }
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
   * Полный post-submit rollback: cancel venue-ордер → release резервации ТОЛЬКО
   * после подтверждённого cancel → journal release ТОЛЬКО после успешного
   * Portfolio release → mark submission UNKNOWN.
   *
   * @param args - `venueOrderId`, `stage`, `clientOrderId`, `accountId`,
   *   `instrumentId`, `attempt`, `transportErrorMessage`, `releaseReservation`
   *   (closure, освобождающая корректную сумму резервации)
   *
   * @remarks
   * Порядок КРИТИЧЕН:
   * 1. `cancelOrder(venueOrderId)`.
   * 2. Политика (`_cancelVenueOrderBeforeReservationRelease`): release разрешён
   *    только при `CANCELLED`/`ALREADY_CANCELLED`. При `ALREADY_FILLED`/
   *    `UNKNOWN_RETRY_NEEDED`/`NOT_FOUND`/transport Err — Portfolio НЕ меняется,
   *    journal остаётся held, ставится блокирующий instrument-marker + issue.
   * 3. Подтверждённый cancel → Portfolio release:
   *    - упал → journal НЕ переводится в SETTLED (помечается
   *      `RECONCILIATION_REQUIRED`), `ORDER_PORTFOLIO_DESYNC` issue;
   *    - успешен → journal release остатка (attempt-scoped operationId,
   *      Result проверяется; сбой → `RESERVATION_JOURNAL_DESYNC` issue) —
   *      journal не остаётся ложно HELD после успешного release.
   * 4. `markSubmissionUnknown` — venue-ордер существовал, авто-retry блокируется.
   */
  private async _rollbackPostSubmit(args: {
    readonly venueOrderId: OrderId;
    readonly stage: string;
    readonly clientOrderId: OrderId;
    readonly accountId: AccountId;
    readonly instrumentId: InstrumentId;
    readonly attempt: number;
    readonly transportErrorMessage: string;
    readonly releaseReservation: () => ReturnType<PortfolioService['releaseReservation']>;
  }): Promise<void> {
    // Exception boundary: брошенный cancelOrder трактуем как транспортный Err
    // (политика ниже оставит резервацию held + issue), а не пробрасываем наружу.
    let cancelResult: Awaited<ReturnType<IExchangeClient['cancelOrder']>>;
    try {
      cancelResult = await this._deps.exchangeClient.cancelOrder(args.venueOrderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cancelResult = Err(new ExchangeError(`cancelOrder threw: ${message}`));
    }
    const { shouldReleaseReservation, cancelOutcome } = await this._cancelVenueOrderBeforeReservationRelease({
      venueOrderId: args.venueOrderId,
      cancelResult,
      stage: args.stage,
      clientOrderId: args.clientOrderId,
      accountId: args.accountId,
      instrumentId: args.instrumentId,
      transportErrorMessage: args.transportErrorMessage,
    });

    if (shouldReleaseReservation) {
      const releaseResult = args.releaseReservation();
      if (!releaseResult.ok) {
        // Portfolio release упал → journal НЕ SETTLED (RECONCILIATION_REQUIRED)
        // + manual block на инструмент.
        this._logger.error('Failed to release reservation after confirmed cancel in rollback — manual reconciliation required', {
          venueOrderId: String(args.venueOrderId),
          stage: args.stage,
          releaseError: releaseResult.error.message,
        });
        await this._markJournalReconciliationRequired(
          args.clientOrderId,
          `attempt:${args.attempt}:rollback:${args.stage}:release-failed`,
        );
        this._deps.orderStateStore.markManualReconciliationBlock({
          orderId: args.venueOrderId,
          instrumentId: args.instrumentId,
          reason: `PLACE_ROLLBACK_RELEASE_FAILED (${args.stage}): ${releaseResult.error.message}`,
        });
        await this._addRollbackReleaseIssue({
          releaseError: releaseResult.error.message,
          stage: args.stage,
          clientOrderId: args.clientOrderId,
          accountId: args.accountId,
          instrumentId: args.instrumentId,
          venueOrderId: args.venueOrderId,
        });
      } else {
        // Portfolio release подтверждён → journal release остатка (SETTLED).
        await this._releaseJournalRemainingAfterConfirmedRelease({
          clientOrderId: args.clientOrderId,
          venueOrderId: args.venueOrderId,
          accountId: args.accountId,
          instrumentId: args.instrumentId,
          operationId: `attempt:${args.attempt}:rollback:${args.stage}`,
          stage: args.stage,
        });
      }
    }

    // Venue-ордер существовал — блокируем авто-retry с тем же clientOrderId.
    await this._markSubmissionUnknown(
      args.clientOrderId,
      `ROLLBACK_${args.stage.toUpperCase().replace(/-/g, '_')}: cancelOutcome=${cancelOutcome}`,
      args.venueOrderId,
    );
  }

  /**
   * Journal release остатка резервации ПОСЛЕ подтверждённого Portfolio release.
   *
   * @param args - `clientOrderId`, `venueOrderId`, `accountId`, `instrumentId`,
   *   `operationId` (attempt-scoped), `stage`
   *
   * @remarks
   * Вызывается ТОЛЬКО когда Portfolio release успешен: journal обязан перейти
   * в SETTLED, чтобы не остаться ложно HELD (иначе поздний fill выбрал бы
   * held-recovery path на уже освобождённый капитал). Сбой journal — blocking
   * `RESERVATION_JOURNAL_DESYNC` issue (Result обязательно проверяется).
   */
  private async _releaseJournalRemainingAfterConfirmedRelease(args: {
    readonly clientOrderId: OrderId;
    readonly venueOrderId?: OrderId;
    readonly accountId: AccountId;
    readonly instrumentId: InstrumentId;
    readonly operationId: string;
    readonly stage: string;
  }): Promise<void> {
    let journalError: string | undefined;
    try {
      const record = await this._deps.submissions.get(args.clientOrderId);
      if (!record) return;
      const remaining = new Decimal(record.reservation.remaining);
      if (remaining.lessThanOrEqualTo(0)) return;
      const r = await this._deps.submissions.applyReservationTransition(args.clientOrderId, {
        operationId: args.operationId,
        release: remaining.toString(),
        now: this._deps.clock.now(),
      });
      if (!r.ok) {
        journalError = r.error.message;
      }
    } catch (err) {
      journalError = err instanceof Error ? err.message : String(err);
    }
    if (journalError !== undefined) {
      // Journal остался НЕ settled при уже освобождённом Portfolio — desync:
      // best-effort RECONCILIATION_REQUIRED + manual block, чтобы задержанный
      // fill на этот venueOrderId не выбрал held-path на чужой капитал.
      this._logger.error('Reservation journal release failed after confirmed Portfolio release — journal desync, manual reconciliation required', {
        clientOrderId: String(args.clientOrderId),
        stage: args.stage,
        operationId: args.operationId,
        error: journalError,
      });
      await this._markJournalReconciliationRequired(args.clientOrderId, `${args.operationId}:journal-release-failed`);
      this._deps.orderStateStore.markManualReconciliationBlock({
        orderId: args.venueOrderId ?? args.clientOrderId,
        instrumentId: args.instrumentId,
        reason: `PLACE_ROLLBACK_JOURNAL_RELEASE_FAILED (${args.stage}): ${journalError}`,
      });
      await this._addReconciliationIssue({
        id: args.venueOrderId
          ? `reconciliation:place-rollback:${String(args.venueOrderId)}:journal-release-failed`
          : `reconciliation:place-rollback-client:${String(args.clientOrderId)}:journal-release-failed`,
        type: 'RESERVATION_JOURNAL_DESYNC',
        status: 'OPEN',
        reason: `PLACE_ROLLBACK_JOURNAL_RELEASE_FAILED: ${journalError}`,
        createdAt: this._deps.clock.now(),
        ...(args.venueOrderId ? { orderId: args.venueOrderId } : {}),
        accountId: args.accountId,
        instrumentId: args.instrumentId,
        context: { stage: args.stage, clientOrderId: String(args.clientOrderId), operationId: args.operationId },
      });
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
      // Precheck — fail-fast вне lock: pending BUY-экспозиция считается только
      // под lock (authoritative), здесь консервативно 0 (не приведёт к ложному
      // reject). timeToExpiryMs пересчитывается отдельно и здесь, и под lock.
      pendingBuyQuantityForInstrument: Quantity.of(new Decimal(0)),
      timeToExpiryMs: this._computeTimeToExpiryMs(input.instrumentId),
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
    // Lock удерживается на время network call submitOrder и commit; события
    // только ENQUEUE-ятся под lock, а публикуются (flush) уже ПОСЛЕ выхода из
    // lock — это исключает deadlock (handler ORDER_ACCEPTED → lock-зависимый
    // use-case) и сохраняет per-order порядок (см. IOrderedEventOutbox).
    // TODO: replace long-held venue lock with PendingVenueOrderRegistry / UnitOfWork.
    const lockKeys = [
      lockKey.account(input.accountId),
      lockKey.instrument(input.instrumentId),
    ];
    const lockedResult = await this._deps.keyedMutex.runExclusive(
      lockKeys,
      () => this._placeLocked(input),
    );

    // flush() ВНЕ lock: публикует enqueued события (никогда не бросает — ошибки
    // публикации проглатываются в outbox с EVENT_PUBLISH_FAILED issue).
    await this._deps.orderedEventOutbox.flush();

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
   * **enqueue событий в outbox** (шаг 7). Публикация (`flush`) выполняется уже
   * ПОСЛЕ выхода из lock (в `execute()`), но per-order порядок сохраняет сам
   * outbox (FIFO по aggregateId): конкурентный Fill, ждущий тот же mutex,
   * enqueue-ит `ORDER_FILLED` в ту же очередь ПОЗЖЕ и не опубликует его раньше
   * `ORDER_CREATED`/`ORDER_ACCEPTED`. Состояние Portfolio/Order последовательно
   * относительно конкурентных fills/cancels этого инструмента/аккаунта.
   */
  private async _placeLocked(input: PlaceOrderInput): Promise<Result<PlaceCommitResult, PlaceOrderError>> {
    // Шаг -1: Unsettled fills guard — ВНУТРИ account/instrument mutex, ДО
    // begin() и любых мутаций. Пока на инструменте есть незавершённый fill
    // (venue in-flight ЛИБО application processing-блок FAILED_RETRYABLE/
    // RECONCILIATION_REQUIRED), новые размещения запрещены: reserve поверх
    // неулаженного fill мог бы заморозить капитал дважды/поверх desync.
    // Scheduler-guard остаётся ранней оптимизацией; correctness обеспечивает
    // сам use-case (здесь, под lock).
    if (this._deps.orderStateStore.hasUnsettledFills(input.instrumentId)) {
      this._logger.warn('PlaceOrder blocked — instrument has unsettled fills (in-flight or processing block)', {
        clientOrderId: String(input.orderId),
        instrumentId: String(input.instrumentId),
        inFlightFillIds: this._deps.orderStateStore.getInFlightFills(input.instrumentId).map((f) => String(f.fillId)),
        processingBlocks: this._deps.orderStateStore.getFillProcessingBlocks(input.instrumentId).map((b) => `${String(b.fillId)}:${b.status}`),
      });
      return Err(new TradingError(
        `Order placement blocked — instrument has unsettled fills: ${String(input.instrumentId)}`,
        { context: { clientOrderId: String(input.orderId), instrumentId: String(input.instrumentId) } },
      ));
    }

    // Шаг 0: Submission guard по clientOrderId. Защита от небезопасного
    // повторного submit того же clientOrderId: venue идемпотентен по
    // clientOrderId и может вернуть тот же venueOrderId; без guard второй
    // execute() попал бы в save-conflict и отменил бы успешно созданный ордер.
    // Выполняется ПЕРВЫМ (до reserve/submit). fingerprint защищает от
    // переиспользования clientOrderId под ДРУГИЕ параметры.
    const fingerprint = this._buildFingerprint(input);
    const begin = await this._deps.submissions.begin({
      clientOrderId: input.orderId,
      accountId: input.accountId,
      instrumentId: input.instrumentId,
      fingerprint,
      side: input.side,
      orderPrice: input.price.value().toString(),
      requestedSize: input.size.value().toString(),
      // Для recovery Order из привязанного venue-ордера (см. запись порта).
      // Защищённая сериализация: legacy string-представление AssetId проходит
      // как есть, сбой сериализации не блокирует размещение (поле optional).
      ...(safeAssetId(input.asset) !== undefined ? { assetId: safeAssetId(input.asset) } : {}),
      strategyId: input.strategyId,
      now: this._deps.clock.now(),
    });
    if (begin.outcome === 'FINGERPRINT_MISMATCH') {
      // clientOrderId переиспользован под другой ордер — вернуть ALREADY_COMMITTED
      // (чужой venueOrderId) было бы опасно. Блокируем, issue, Err. НЕ submit.
      this._logger.error('PlaceOrder blocked — clientOrderId reused with different parameters (fingerprint mismatch)', {
        clientOrderId: String(input.orderId),
        expectedFingerprint: begin.expectedFingerprint,
        actualFingerprint: begin.actualFingerprint,
      });
      await this._addReconciliationIssue({
        id: `reconciliation:submit-client:${String(input.orderId)}:fingerprint-mismatch`,
        type: 'VENUE_LOCAL_ORDER_DESYNC',
        status: 'OPEN',
        reason: 'FINGERPRINT_MISMATCH: clientOrderId reused with different order parameters',
        createdAt: this._deps.clock.now(),
        ...(begin.record.venueOrderId ? { orderId: begin.record.venueOrderId } : {}),
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        context: {
          clientOrderId: String(input.orderId),
          expectedFingerprint: begin.expectedFingerprint,
          actualFingerprint: begin.actualFingerprint,
          priorStatus: begin.record.status,
        },
      });
      return Err(new TradingError(
        `Order submission blocked — clientOrderId reused with different parameters: ${String(input.orderId)}`,
        { context: { clientOrderId: String(input.orderId) } },
      ));
    }
    // Stage 5: повреждённая запись — COMMITTED/VENUE_ACCEPTED БЕЗ venueOrderId.
    // Это нарушение инварианта (venue создал ордер, но id не сохранён —
    // персистентный адаптер вернул повреждённые данные). НЕЛЬЗЯ reserve/submit
    // (создали бы дубль на venue) и НЕЛЬЗЯ markFailed (сделало бы retryable).
    // Hard error + детерминированный issue, ДО risk/reserve/submit/cancel.
    if (
      (begin.outcome === 'ALREADY_COMMITTED' || begin.outcome === 'VENUE_ACCEPTED') &&
      !begin.record.venueOrderId
    ) {
      this._logger.error('CORRUPT_SUBMISSION: prior submission COMMITTED/VENUE_ACCEPTED without venueOrderId — cannot reserve or submit, manual reconciliation required', {
        clientOrderId: String(input.orderId),
        submissionStatus: begin.record.status,
        fingerprint: begin.record.fingerprint,
      });
      await this._addReconciliationIssue({
        id: `reconciliation:submit-client:${String(input.orderId)}:corrupt-submission-missing-venue-order-id`,
        type: 'VENUE_LOCAL_ORDER_DESYNC',
        status: 'OPEN',
        reason: `CORRUPT_SUBMISSION_MISSING_VENUE_ORDER_ID: submission ${begin.record.status} without venueOrderId`,
        createdAt: this._deps.clock.now(),
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        context: {
          clientOrderId: String(input.orderId),
          submissionStatus: begin.record.status,
          fingerprint: begin.record.fingerprint,
          stage: 'corrupt-submission-missing-venue-order-id',
        },
      });
      return Err(new TradingError(
        `Order submission blocked — corrupt submission record (${begin.record.status} without venueOrderId) for clientOrderId: ${String(input.orderId)}`,
        { context: { clientOrderId: String(input.orderId), submissionStatus: begin.record.status } },
      ));
    }

    if (begin.outcome === 'ALREADY_COMMITTED') {
      // Повторный submit уже закоммиченного ордера — возвращаем существующий
      // venueOrderId, НЕ submit-им и НЕ cancel-им. (venueOrderId гарантированно
      // присутствует — corrupt-случай отсеян выше.)
      const venueOrderId = begin.record.venueOrderId;
      if (venueOrderId) {
        this._logger.warn('Duplicate PlaceOrder for already-committed clientOrderId — returning existing venueOrderId', {
          clientOrderId: String(input.orderId),
          venueOrderId: String(venueOrderId),
        });
        return Ok({ venueOrderId });
      }
    }
    if (begin.outcome === 'VENUE_ACCEPTED') {
      // Прошлый submit получил venueOrderId, но local save не завершился (крэш).
      // НЕ submit-им повторно. Если local Order уже появился (гонка) — вернём его;
      // иначе — issue для ручной реконсиляции существующего venue-ордера.
      const venueOrderId = begin.record.venueOrderId;
      if (venueOrderId) {
        const existingOrder = await this._deps.orderRepo.get(venueOrderId);
        if (existingOrder) {
          await this._safeMarkCommitted(input, venueOrderId);
          this._logger.warn('PlaceOrder retry found VENUE_ACCEPTED with existing local Order — returning existing venueOrderId', {
            clientOrderId: String(input.orderId),
            venueOrderId: String(venueOrderId),
          });
          return Ok({ venueOrderId });
        }
        this._logger.error('PlaceOrder blocked — prior submission VENUE_ACCEPTED but local Order missing, manual reconciliation required', {
          clientOrderId: String(input.orderId),
          venueOrderId: String(venueOrderId),
        });
        await this._addReconciliationIssue({
          id: `reconciliation:submit:${String(venueOrderId)}:venue-accepted-no-local-order`,
          type: 'VENUE_LOCAL_ORDER_DESYNC',
          status: 'OPEN',
          reason: 'PRIOR_SUBMISSION_VENUE_ACCEPTED_WITHOUT_LOCAL_ORDER: venue order exists, local Order missing',
          createdAt: this._deps.clock.now(),
          orderId: venueOrderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          context: { clientOrderId: String(input.orderId), submissionStatus: 'VENUE_ACCEPTED' },
        });
        return Err(new TradingError(
          `Order submission blocked — prior VENUE_ACCEPTED without local order for clientOrderId: ${String(input.orderId)}`,
          { context: { clientOrderId: String(input.orderId), venueOrderId: String(venueOrderId) } },
        ));
      }
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
      return Err(new PlaceOrderFailureError(
        'SUBMISSION_OUTCOME_UNKNOWN',
        `Order submission blocked — prior UNKNOWN outcome for clientOrderId: ${String(input.orderId)}`,
        { context: { clientOrderId: String(input.orderId) } },
      ));
    }
    if (begin.outcome === 'CANCELLED_NO_RESUBMIT') {
      // Прошлый venue-ордер под этим clientOrderId ДЕЙСТВИТЕЛЬНО существовал
      // и был операторски отменён (CancelBoundVenueOrderUseCase) — в отличие
      // от FAILED (ордер точно не создан), здесь retry под тем же
      // clientOrderId навсегда запрещён. НЕ resubmit — issue + Err.
      this._logger.error('PlaceOrder blocked — clientOrderId was CANCELLED after a confirmed venue order, reuse forbidden', {
        clientOrderId: String(input.orderId),
        venueOrderId: begin.record.venueOrderId ? String(begin.record.venueOrderId) : undefined,
      });
      await this._addReconciliationIssue({
        id: `reconciliation:submit-client:${String(input.orderId)}:cancelled-no-resubmit`,
        type: 'SUBMIT_UNKNOWN_OUTCOME',
        status: 'OPEN',
        reason: `PRIOR_SUBMISSION_CANCELLED: ${begin.record.reason ?? 'operator-cancelled bound venue order'}`,
        createdAt: this._deps.clock.now(),
        ...(begin.record.venueOrderId ? { orderId: begin.record.venueOrderId } : {}),
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        context: { clientOrderId: String(input.orderId), submissionStatus: 'CANCELLED' },
      });
      return Err(new TradingError(
        `Order submission blocked — clientOrderId was CANCELLED, use a new clientOrderId: ${String(input.orderId)}`,
        { context: { clientOrderId: String(input.orderId) } },
      ));
    }
    if (begin.outcome === 'RECONCILIATION_REQUIRED') {
      // Прошлый submit FAILED, но резервация НЕ подтверждённо снята
      // (HELD/PARTIALLY_SETTLED/RECONCILIATION_REQUIRED или remaining > 0).
      // Retry запрещён: повторный reserve заморозил бы капитал дважды.
      // НЕ выполняем risk/reserve/submit — issue + Err.
      this._logger.error('PlaceOrder blocked — prior FAILED submission has unresolved reservation, retry forbidden, manual reconciliation required', {
        clientOrderId: String(input.orderId),
        reservationStatus: begin.record.reservation.status,
        reservationRemaining: begin.record.reservation.remaining,
        attempt: begin.record.attempt,
      });
      await this._addReconciliationIssue({
        id: `reconciliation:submit-client:${String(input.orderId)}:retry-blocked-unresolved-reservation`,
        type: 'ORDER_PORTFOLIO_DESYNC',
        status: 'OPEN',
        reason: `SUBMISSION_RETRY_BLOCKED_UNRESOLVED_RESERVATION: reservation ${begin.record.reservation.status}, remaining=${begin.record.reservation.remaining}`,
        createdAt: this._deps.clock.now(),
        ...(begin.record.venueOrderId ? { orderId: begin.record.venueOrderId } : {}),
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        context: {
          clientOrderId: String(input.orderId),
          reservationStatus: begin.record.reservation.status,
          reservationRemaining: begin.record.reservation.remaining,
          attempt: begin.record.attempt,
        },
      });
      return Err(new TradingError(
        `Order submission blocked — unresolved reservation from prior FAILED attempt for clientOrderId: ${String(input.orderId)}`,
        { context: { clientOrderId: String(input.orderId), reservationStatus: begin.record.reservation.status } },
      ));
    }
    // ACQUIRED / FAILED_RETRYABLE → продолжаем. Текущий attempt — из записи
    // ПОСЛЕ begin (retry уже увеличил его); все reservation operation IDs ниже
    // scoped по attempt, чтобы операции разных попыток не считались дубликатами.
    const attempt = (await this._deps.submissions.get(input.orderId))?.attempt ?? 1;

    // Шаг 1b: Authoritative риск-проверка на СВЕЖЕМ состоянии.
    // input.portfolio и input.openOrdersCount — snapshot, собранный ДО lock;
    // пока ждали lock, конкурентный place/fill мог изменить баланс/экспозицию
    // и число открытых ордеров. Перечитываем portfolio и openOrdersCount под
    // lock и повторяем проверку.
    //
    // Portfolio БЕЗ fallback на input.portfolio: authoritative-проверка обязана
    // быть на свежем состоянии. Если Portfolio не инициализирован — Err (ордер
    // ещё не отправлялся, reserve/cancel не нужны).
    const freshPortfolio = this._deps.portfolioService.getPortfolio(input.accountId);
    if (!freshPortfolio) {
      this._logger.error('Portfolio not initialized under lock — aborting PlaceOrder', {
        accountId: accountIdToString(input.accountId),
        clientOrderId: String(input.orderId),
      });
      await this._markSubmissionFailed(input.orderId, 'PORTFOLIO_NOT_INITIALIZED');
      return Err(new PlaceOrderFailureError('PORTFOLIO_UNAVAILABLE', 'Portfolio not initialized', {
        context: { accountId: accountIdToString(input.accountId), clientOrderId: String(input.orderId) },
      }));
    }
    const freshOpenOrdersCount = await this._deps.orderRepo.countByStrategyId(input.strategyId);

    // Authoritative pending BUY-экспозиция по инструменту (submission journal).
    // Только для BUY: SELL пропускает position/exposure gates, значение не нужно.
    // Fail-closed: повреждённые price/reservation данные → блокируем BUY (нельзя
    // проверить position-лимит). Ордер ещё не отправлялся — submission retryable.
    let pendingBuyQuantityForInstrument = Quantity.of(new Decimal(0));
    if (input.side === 'BUY') {
      const pendingResult = await this._deps.submissions.getPendingBuyQuantityForInstrument(
        input.accountId,
        input.instrumentId,
      );
      if (!pendingResult.ok) {
        this._logger.error('Failed to compute pending BUY exposure (fail-closed) — blocking order', {
          clientOrderId: String(input.orderId),
          instrumentId: String(input.instrumentId),
          error: pendingResult.error.message,
        });
        await this._markSubmissionFailed(input.orderId, `PENDING_BUY_QUERY_FAILED: ${pendingResult.error.message}`);
        // Типизированный RISK_STATE_UNAVAILABLE (а не общий TradingError) — метрики
        // отличают недоступность authoritative-состояния от нарушения лимита.
        return Err(new RiskViolationError(
          'RISK_STATE_UNAVAILABLE',
          `Cannot compute pending BUY exposure — risk state unavailable: ${pendingResult.error.message}`,
          { clientOrderId: String(input.orderId), instrumentId: String(input.instrumentId) },
        ));
      }
      // Порт (IOrderSubmissionRepository) остаётся Decimal-based (persisted-DTO
      // граница, Этап 5) — оборачиваем в Quantity здесь, на границе use-cases.
      pendingBuyQuantityForInstrument = Quantity.of(pendingResult.value);
    }

    const riskResult = this._deps.riskChecker.checkBeforeOrder({
      portfolio: freshPortfolio,
      openOrdersCount: freshOpenOrdersCount,
      side: input.side,
      price: input.price,
      size: input.size,
      instrumentId: input.instrumentId,
      strategyId: input.strategyId,
      pendingBuyQuantityForInstrument,
      // Пересчитываем expiry под lock (время ожидания lock + network могло пройти).
      timeToExpiryMs: this._computeTimeToExpiryMs(input.instrumentId),
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
    const notional = isBuy ? Money.of(input.price.value().times(input.size.value()), 'USDC') : undefined;
    const reserveResult = isBuy
      ? this._deps.portfolioService.reserveForOrder(input.accountId, notional!)
      : this._deps.portfolioService.reserveTokensForOrder(
          input.accountId,
          input.instrumentId,
          input.size,
        );
    if (!reserveResult.ok) {
      // Ордер не отправлялся — submission можно retry-ить.
      await this._markSubmissionFailed(input.orderId, `RESERVE_FAILED: ${reserveResult.error.message}`);
      return Err(new TradingError(
        `Failed to reserve ${isBuy ? 'balance' : 'tokens'}: ${reserveResult.error.message}`,
        {
          context: {
            clientOrderId: String(input.orderId),
            ...(isBuy ? { notional: notional!.value().toString() } : { instrumentId: String(input.instrumentId), size: input.size.value().toString() }),
          },
        },
      ));
    }
    // Резервация успешна → фиксируем held в execution journal (recovery-путь для
    // Fill без локального Order). BUY: initial = notional (USDC); SELL: initial =
    // размер токенов. COMMIT-CRITICAL (не best-effort): при сбое журнала submit
    // НЕ выполняется — компенсирующе освобождаем Portfolio-резервацию:
    // - компенсация успешна → markFailed (retry безопасен: Portfolio чист,
    //   journal остался NONE);
    // - компенсация упала → submission остаётся SUBMITTING (blocking, retry
    //   заблокирован), journal → RECONCILIATION_REQUIRED, ORDER_PORTFOLIO_DESYNC issue.
    const reservationInitial = isBuy ? notional!.value().toString() : input.size.value().toString();
    const heldResult = await this._markReservationHeldCritical(input.orderId, reservationInitial);
    if (!heldResult.ok) {
      this._logger.error('Failed to mark reservation HELD in execution journal — aborting submit, compensating Portfolio release', {
        clientOrderId: String(input.orderId),
        initial: reservationInitial,
        error: heldResult.error.message,
      });
      const compensateResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
        : this._deps.portfolioService.releaseTokenReservation(input.accountId, input.instrumentId, input.size);
      if (compensateResult.ok) {
        // Portfolio восстановлен, journal пуст (NONE) — retry безопасен.
        await this._markSubmissionFailed(input.orderId, `JOURNAL_HELD_FAILED: ${heldResult.error.message}`);
        return Err(new TradingError(
          `Failed to record reservation in execution journal (submit aborted, reservation compensated): ${heldResult.error.message}`,
          { context: { clientOrderId: String(input.orderId) } },
        ));
      }
      // Компенсация упала: Portfolio держит резервацию, journal о ней не знает.
      // Submission НЕ markFailed (остаётся SUBMITTING → begin вернёт IN_PROGRESS,
      // retry заблокирован); journal → RECONCILIATION_REQUIRED; blocking issue.
      this._logger.error('Compensating Portfolio release failed after journal HELD failure — submission blocked, manual reconciliation required', {
        clientOrderId: String(input.orderId),
        releaseError: compensateResult.error.message,
      });
      await this._markJournalReconciliationRequired(
        input.orderId,
        `attempt:${attempt}:journal-held-failed:compensation-failed`,
      );
      this._deps.orderStateStore.markManualReconciliationBlock({
        orderId: input.orderId,
        instrumentId: input.instrumentId,
        reason: `PLACE_JOURNAL_HELD_COMPENSATION_FAILED: ${compensateResult.error.message}`,
      });
      await this._addRollbackReleaseIssue({
        releaseError: `journal HELD failed (${heldResult.error.message}); compensating release failed (${compensateResult.error.message})`,
        stage: 'journal-held-failure-compensation',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
      });
      return Err(new TradingError(
        `Failed to record reservation in execution journal and compensating release failed (submission blocked, manual reconciliation required): ${heldResult.error.message}`,
        { context: { clientOrderId: String(input.orderId), releaseError: compensateResult.error.message } },
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
    // Exception boundary: контракт IExchangeClient — Result, но неожиданный
    // rejected Promise (баг адаптера, сеть до классификации) НЕ должен
    // пробрасываться наружу: Portfolio уже зарезервирован и journal HELD —
    // без boundary submission навсегда осталась бы SUBMITTING (IN_PROGRESS)
    // без issue. Консервативно трактуем throw как транспортную ошибку
    // MAY_HAVE_BEEN_SUBMITTED (доказать обратное невозможно).
    let submitResult: Awaited<ReturnType<IExchangeClient['submitOrder']>>;
    try {
      submitResult = await this._deps.exchangeClient.submitOrder(submitParams);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('Exchange submit threw unexpectedly — treating as MAY_HAVE_BEEN_SUBMITTED transport error', {
        clientOrderId: String(input.orderId),
        error: message,
      });
      submitResult = Err(new ExchangeError(`submitOrder threw: ${message}`, {
        submitOutcome: 'MAY_HAVE_BEEN_SUBMITTED',
      }));
    }

    if (!submitResult.ok) {
      // Транспортная/API ошибка submit. Ключевой вопрос: ДОШЛА ли отправка до
      // venue (мог ли ордер создаться)? Читаем ExchangeError.submitOutcome.
      // Conservative default (поле не задано) — MAY_HAVE_BEEN_SUBMITTED: для
      // live trading безопаснее считать ордер потенциально созданным.
      const submitOutcome = submitResult.error.submitOutcome ?? 'MAY_HAVE_BEEN_SUBMITTED';

      if (submitOutcome === 'MAY_HAVE_BEEN_SUBMITTED') {
        // Ambiguous: venue-ордер МОГ быть создан. НЕ освобождаем резервацию
        // (если ордер live/исполнится, разморозка → потеря учёта). Трактуем как
        // UNKNOWN — Order НЕ создаём, issue reservationHeld=true, markUnknown.
        this._logger.error('Exchange submit transport error MAY_HAVE_BEEN_SUBMITTED — venue order may be live, reservation held, manual reconciliation required', {
          clientOrderId: String(input.orderId),
          error: submitResult.error.message,
        });
        // venueOrderId НЕИЗВЕСТЕН: поздний Fill не сможет найти запись через
        // findByVenueOrderId и ушёл бы в direct path (двойной дебет при held
        // резервации). Manual block на инструмент (ключ — clientOrderId)
        // блокирует fills/place/cancel до привязки venueOrderId reconciler'ом
        // (ReconcileUnknownSubmissionsUseCase) либо ручной реконсиляции.
        this._deps.orderStateStore.markManualReconciliationBlock({
          orderId: input.orderId,
          instrumentId: input.instrumentId,
          reason: `SUBMIT_MAY_HAVE_BEEN_SUBMITTED_NO_VENUE_ORDER_ID: ${submitResult.error.message}`,
        });
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
            reservationHeld: true,
          },
        });
        // Submission ambiguous — блокируем авто-retry (begin вернёт UNKNOWN).
        await this._markSubmissionUnknown(input.orderId, `SUBMIT_TRANSPORT_MAY_HAVE_BEEN_SUBMITTED: ${submitResult.error.message}`);
        return Err(new PlaceOrderFailureError(
          'SUBMISSION_OUTCOME_UNKNOWN',
          `Exchange submit transport error (may have been submitted, reservation held, manual reconciliation): ${submitResult.error.message}`,
          { context: { clientOrderId: String(input.orderId), submitOutcome, reservationHeld: true } },
        ));
      }

      // DEFINITELY_NOT_SUBMITTED: ордер точно не создан — подтверждённый rollback
      // (Portfolio → journal → только потом markFailed) + Err. Release безопасен
      // (venue-ордера гарантированно нет), но retry разрешается ТОЛЬКО после
      // подтверждённого Portfolio + journal rollback (см. helper).
      this._logger.warn('Exchange submit failed (definitely not submitted), rolling back reservation', {
        clientOrderId: String(input.orderId),
        error: submitResult.error.message,
      });
      const rollback = await this._releaseReservationBeforeRetry({
        input,
        attempt,
        rollbackSlug: 'definitely-not-submitted',
        reservationInitial,
        releaseReservation: () =>
          isBuy
            ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
            : this._deps.portfolioService.releaseTokenReservation(input.accountId, input.instrumentId, input.size),
        failReason: `SUBMIT_DEFINITELY_NOT_SUBMITTED: ${submitResult.error.message}`,
        stage: 'submit-definitely-not-submitted-rollback',
      });
      return Err(new PlaceOrderFailureError(
        'DEFINITELY_REJECTED',
        `Exchange submission failed: ${submitResult.error.message}`,
        {
          context: {
            clientOrderId: String(input.orderId),
            submitOutcome,
            rollbackError: rollback.releaseError,
          },
        },
      ));
    }

    const submitValue = submitResult.value;

    // REJECTED: venue явно отклонил ордер, live-ордера не существует — откатываем
    // резервацию под ПОЛНЫЙ исходный size (адаптер ничего не отправил на venue-side,
    // корректировать нечего) и не создаём локальный Order. Retry разрешается
    // ТОЛЬКО после подтверждённого Portfolio + journal rollback (см. helper).
    if (submitValue.status === 'REJECTED') {
      this._logger.warn('Exchange rejected order (no live order created), rolling back reservation', {
        clientOrderId: String(input.orderId),
        reason: submitValue.reason,
      });
      const rollback = await this._releaseReservationBeforeRetry({
        input,
        attempt,
        rollbackSlug: 'rejected',
        reservationInitial,
        releaseReservation: () =>
          isBuy
            ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
            : this._deps.portfolioService.releaseTokenReservation(input.accountId, input.instrumentId, input.size),
        failReason: `SUBMIT_REJECTED: ${submitValue.reason}`,
        stage: 'rejected-submit-rollback',
      });
      // Типизированный маппинг venue-классификации (adapter → ports → use case).
      // POST_ONLY_WOULD_TAKE / INSUFFICIENT_TOKEN_BALANCE / INSUFFICIENT_ALLOWANCE
      // выставляются ТОЛЬКО из definite REJECTED-исхода; balance-metadata
      // пробрасывается как есть (Decimal, микроединицы) — без парсинга текста.
      const rejectionCode = submitValue.rejectionCode;
      const failureCode: import('./PlaceOrderFailure.js').PlaceFailureCode =
        rejectionCode === 'POST_ONLY_WOULD_TAKE' ? 'POST_ONLY_WOULD_TAKE'
          : rejectionCode === 'INSUFFICIENT_TOKEN_BALANCE' ? 'INSUFFICIENT_TOKEN_BALANCE'
          : rejectionCode === 'INSUFFICIENT_ALLOWANCE' ? 'INSUFFICIENT_ALLOWANCE'
          : 'DEFINITELY_REJECTED';
      return Err(new PlaceOrderFailureError(
        failureCode,
        `Exchange rejected order: ${submitValue.reason}`,
        {
          context: {
            clientOrderId: String(input.orderId),
            rollbackError: rollback.releaseError,
          },
          ...(submitValue.balance !== undefined ? { balance: submitValue.balance } : {}),
        },
      ));
    }

    // UNKNOWN: ответ venue не укладывается в безопасную модель — НЕ создаём обычный
    // OPEN order. Резервацию освобождаем ТОЛЬКО если venue вернул orderId И cancel
    // подтверждён (CANCELLED/ALREADY_CANCELLED). Без orderId или при ambiguous
    // cancel (ALREADY_FILLED/UNKNOWN_RETRY_NEEDED/NOT_FOUND/Err) — резервация
    // остаётся held (venue-ордер мог быть live/исполниться).
    if (submitValue.status === 'UNKNOWN') {
      this._logger.error('Exchange submit result ambiguous (UNKNOWN) — manual reconciliation required', {
        clientOrderId: String(input.orderId),
        reason: submitValue.reason,
        venueOrderId: submitValue.orderId ? String(submitValue.orderId) : undefined,
      });

      let reservationReleased = false;
      let cancelOutcome = 'NO_ORDER_ID';
      const releaseFullReservation = (): ReturnType<PortfolioService['releaseReservation']> =>
        isBuy
          ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
          : this._deps.portfolioService.releaseTokenReservation(input.accountId, input.instrumentId, input.size);

      if (submitValue.orderId) {
        // Exception boundary: брошенный cancelOrder → транспортный Err (см. _rollbackPostSubmit).
        let cancelExchangeResult: Awaited<ReturnType<IExchangeClient['cancelOrder']>>;
        try {
          cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(submitValue.orderId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          cancelExchangeResult = Err(new ExchangeError(`cancelOrder threw: ${message}`));
        }
        const policy = await this._cancelVenueOrderBeforeReservationRelease({
          venueOrderId: submitValue.orderId,
          cancelResult: cancelExchangeResult,
          stage: 'unknown-submit-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          transportErrorMessage: 'Failed to cancel exchange order after UNKNOWN submit result — venue order may still be live, manual reconciliation required',
        });
        cancelOutcome = policy.cancelOutcome;
        if (policy.shouldReleaseReservation) {
          const releaseResult = releaseFullReservation();
          reservationReleased = releaseResult.ok;
          if (!releaseResult.ok) {
            // Portfolio release упал → journal НЕ переводится в SETTLED + manual block.
            await this._markJournalReconciliationRequired(
              input.orderId,
              `attempt:${attempt}:rollback:unknown-submit-rollback:release-failed`,
            );
            this._deps.orderStateStore.markManualReconciliationBlock({
              orderId: submitValue.orderId,
              instrumentId: input.instrumentId,
              reason: `PLACE_UNKNOWN_SUBMIT_RELEASE_FAILED: ${releaseResult.error.message}`,
            });
            await this._addRollbackReleaseIssue({
              releaseError: releaseResult.error.message,
              stage: 'unknown-submit-rollback',
              clientOrderId: input.orderId,
              accountId: input.accountId,
              instrumentId: input.instrumentId,
              venueOrderId: submitValue.orderId,
            });
          } else {
            // Portfolio release подтверждён → journal release остатка (SETTLED).
            await this._releaseJournalRemainingAfterConfirmedRelease({
              clientOrderId: input.orderId,
              venueOrderId: submitValue.orderId,
              accountId: input.accountId,
              instrumentId: input.instrumentId,
              operationId: `attempt:${attempt}:rollback:unknown-submit-rollback`,
              stage: 'unknown-submit-rollback',
            });
          }
        }
      }

      // Без venueOrderId поздний Fill не найдёт запись (findByVenueOrderId) и
      // ушёл бы в direct path при held-резервации — manual block до привязки
      // venueOrderId reconciler'ом либо ручной реконсиляции.
      if (!submitValue.orderId) {
        this._deps.orderStateStore.markManualReconciliationBlock({
          orderId: input.orderId,
          instrumentId: input.instrumentId,
          reason: `SUBMIT_UNKNOWN_NO_VENUE_ORDER_ID: ${submitValue.reason}`,
        });
      }

      // Issue: исход submit ambiguous — venue-состояние требует ручной проверки.
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
          cancelOutcome,
          reservationHeld: !reservationReleased,
        },
      });
      // Submission ambiguous — блокируем авто-retry (begin вернёт UNKNOWN).
      await this._markSubmissionUnknown(input.orderId, `SUBMIT_UNKNOWN: ${submitValue.reason}`, submitValue.orderId);
      return Err(new PlaceOrderFailureError(
        'SUBMISSION_OUTCOME_UNKNOWN',
        `Exchange submit result ambiguous: ${submitValue.reason}`,
        {
          context: {
            clientOrderId: String(input.orderId),
            venueOrderId: submitValue.orderId ? String(submitValue.orderId) : undefined,
            reservationHeld: !reservationReleased,
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

    // Venue создал ордер и вернул venueOrderId — фиксируем VENUE_ACCEPTED ДО
    // любых local Order операций. Если между этим и markCommitted произойдёт
    // крэш, при рестарте begin() вернёт VENUE_ACCEPTED (guard не сделает
    // повторный submit). Если markVenueAccepted упал — venue-ордер уже
    // существует: cancel (release только после подтверждённого cancel), issue,
    // markUnknown, Err. НЕ продолжаем к local save как ни в чём не бывало.
    try {
      await this._deps.submissions.markVenueAccepted(input.orderId, venueOrderId, this._deps.clock.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('Failed to mark submission VENUE_ACCEPTED after successful submit — venue order exists, rolling back', {
        clientOrderId: String(input.orderId),
        venueOrderId: String(venueOrderId),
        error: message,
      });
      await this._addReconciliationIssue({
        id: `reconciliation:submit:${String(venueOrderId)}:venue-accepted-mark-failed`,
        type: 'VENUE_LOCAL_ORDER_DESYNC',
        status: 'OPEN',
        reason: `MARK_VENUE_ACCEPTED_FAILED: ${message}`,
        createdAt: this._deps.clock.now(),
        orderId: venueOrderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        context: { stage: 'mark-venue-accepted', clientOrderId: String(input.orderId), reservationHeld: true },
      });
      await this._rollbackPostSubmit({
        venueOrderId,
        attempt,
        stage: 'mark-venue-accepted-failure-rollback',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        transportErrorMessage: 'Failed to cancel exchange order after markVenueAccepted failure — venue order may still be live, manual reconciliation required',
        releaseReservation: () =>
          isBuy
            ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
            : this._deps.portfolioService.releaseTokenReservation(input.accountId, input.instrumentId, input.size),
      });
      return Err(new TradingError(
        `Failed to record VENUE_ACCEPTED submission (venue order exists, manual reconciliation): ${message}`,
        { context: { venueOrderId: String(venueOrderId), clientOrderId: String(input.orderId) } },
      ));
    }

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
    // Closure освобождения ПОЛНОЙ исходной резервации (input.size). Используется
    // в rollback-ветках ДО size-adjustment, где держится полный input.size.
    const releaseFullInputReservation = (): ReturnType<PortfolioService['releaseReservation']> =>
      isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
        : this._deps.portfolioService.releaseTokenReservation(input.accountId, input.instrumentId, input.size);

    if (effectiveSize.isZero() || effectiveSize.isGreaterThan(input.size)) {
      this._logger.error('Exchange returned invalid effectiveSize — aborting and cancelling venue order', {
        venueOrderId: String(venueOrderId),
        requestedSize: input.size.value().toString(),
        effectiveSize: effectiveSize.value().toString(),
      });
      // Порядок: cancel venue-ордер → release ТОЛЬКО после подтверждённого cancel.
      await this._rollbackPostSubmit({
        venueOrderId,
        attempt,
        stage: 'invalid-effective-size-rollback',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        transportErrorMessage: 'Failed to cancel exchange order after invalid effectiveSize — venue order may still be live, manual reconciliation required',
        releaseReservation: releaseFullInputReservation,
      });
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
            Money.of(input.price.value().times(excessSize), 'USDC'),
          )
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            Quantity.of(excessSize),
          );
      if (!excessReleaseResult.ok) {
        // Излишек не освободился — полный input.size всё ещё held. Отменяем
        // venue-ордер и (только после подтверждённого cancel) освобождаем полную
        // резервацию, вместо сохранения Order с неверным состоянием резервации.
        this._logger.error('Failed to release excess reservation after size adjustment — aborting, manual reconciliation required', {
          venueOrderId: String(venueOrderId),
          releaseError: excessReleaseResult.error.message,
        });
        await this._rollbackPostSubmit({
          venueOrderId,
          attempt,
          stage: 'excess-release-failure-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          transportErrorMessage: 'Failed to cancel exchange order after excess-release failure — venue order may still be live, manual reconciliation required',
          releaseReservation: releaseFullInputReservation,
        });
        return Err(new TradingError(
          `Failed to release excess reservation after exchange size adjustment: ${excessReleaseResult.error.message}`,
          { context: { venueOrderId: String(venueOrderId) } },
        ));
      }

      orderSize = effectiveSize;
      orderNotional = isBuy ? Money.of(input.price.value().times(effectiveSize.value()), 'USDC') : undefined;

      // Journal: излишек резервации освобождён → released += excess, remaining
      // уменьшается; фиксируем effectiveSize. Attempt-scoped operationId.
      // COMMIT-CRITICAL: при ошибке journal НЕЛЬЗЯ продолжать создание local
      // Order (journal остался бы завышенным относительно Portfolio — held-fill
      // recovery потребил бы несуществующий капитал) — безопасный venue-first
      // rollback оставшейся (уменьшенной) резервации + Err.
      const excessReleaseAmount = isBuy
        ? input.price.value().times(excessSize).toString()
        : excessSize.toString();
      let excessJournalError: string | undefined;
      try {
        await this._deps.submissions.setEffectiveSize(input.orderId, effectiveSize.value().toString(), this._deps.clock.now());
        const excessTransition = await this._deps.submissions.applyReservationTransition(input.orderId, {
          operationId: `attempt:${attempt}:effective-size-excess-release`,
          release: excessReleaseAmount,
          now: this._deps.clock.now(),
        });
        if (!excessTransition.ok) {
          excessJournalError = excessTransition.error.message;
        }
      } catch (err) {
        excessJournalError = err instanceof Error ? err.message : String(err);
      }
      if (excessJournalError !== undefined) {
        this._logger.error('Reservation journal excess-release failed after size adjustment — aborting, venue-first rollback', {
          venueOrderId: String(venueOrderId),
          clientOrderId: String(input.orderId),
          error: excessJournalError,
        });
        // Portfolio к этому моменту держит УМЕНЬШЕННУЮ резервацию
        // (excess уже освобождён) — rollback освобождает именно её.
        await this._rollbackPostSubmit({
          venueOrderId,
          attempt,
          stage: 'excess-journal-failure-rollback',
          clientOrderId: input.orderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          transportErrorMessage: 'Failed to cancel exchange order after excess journal failure — venue order may still be live, manual reconciliation required',
          releaseReservation: () =>
            isBuy
              ? this._deps.portfolioService.releaseReservation(input.accountId, Money.of(input.price.value().times(effectiveSize.value()), 'USDC'))
              : this._deps.portfolioService.releaseTokenReservation(input.accountId, input.instrumentId, effectiveSize),
        });
        return Err(new TradingError(
          `Failed to record excess reservation release in execution journal (local Order not created): ${excessJournalError}`,
          { context: { venueOrderId: String(venueOrderId), clientOrderId: String(input.orderId) } },
        ));
      }
    }

    // Closure освобождения ФАКТИЧЕСКОЙ резервации ордера (orderSize/orderNotional,
    // после возможного size-adjustment). Для rollback-веток ПОСЛЕ adjustment.
    const releaseOrderReservation = (): ReturnType<PortfolioService['releaseReservation']> =>
      isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, orderNotional!)
        : this._deps.portfolioService.releaseTokenReservation(input.accountId, input.instrumentId, orderSize);

    // Шаг 4: Создание Order aggregate с venueOrderId
    const timestampResult = TimestampService.fromDate(this._deps.clock.now());
    if (!timestampResult.ok) {
      await this._rollbackPostSubmit({
        venueOrderId,
        attempt,
        stage: 'timestamp-failure-rollback',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        transportErrorMessage: 'Failed to cancel exchange order after timestamp failure — venue order may still be live, manual reconciliation required',
        releaseReservation: releaseOrderReservation,
      });
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
      accountId: input.accountId,
    });
    if (!orderResult.ok) {
      await this._rollbackPostSubmit({
        venueOrderId,
        attempt,
        stage: 'order-create-failure-rollback',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        transportErrorMessage: 'Failed to cancel exchange order after Order.create failure — venue order may still be live, manual reconciliation required',
        releaseReservation: releaseOrderReservation,
      });
      return Err(orderResult.error);
    }
    const order = orderResult.value;

    // Шаг 5: Принятие ордера (PENDING → OPEN)
    const acceptResult = order.accept();
    if (!acceptResult.ok) {
      await this._rollbackPostSubmit({
        venueOrderId,
        attempt,
        stage: 'accept-failure-rollback',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        transportErrorMessage: 'Failed to cancel exchange order during accept() rollback',
        releaseReservation: releaseOrderReservation,
      });
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
      // Проверяем ФАКТИЧЕСКОЕ наличие Order под venueOrderId: конфликт означает,
      // что запись уже есть. Если это наш ордер (тот же venueOrderId) — он уже
      // committed (гонка reconcile/WS/наш прошлый commit): idempotent success,
      // НЕ отменяем (иначе отменили бы успешно созданный) и НЕ трогаем резервацию.
      const existingOrder = await this._deps.orderRepo.get(venueOrderId);
      if (existingOrder) {
        this._logger.warn('Save conflict with existing Order under same venueOrderId — idempotent, returning existing venueOrderId, no cancel', {
          clientOrderId: String(input.orderId),
          venueOrderId: String(venueOrderId),
        });
        await this._safeMarkCommitted(input, venueOrderId);
        return Ok({ venueOrderId });
      }
      // Дополнительно: submission COMMITTED/VENUE_ACCEPTED с тем же venueOrderId —
      // тоже не отменяем вслепую (наш ордер), issue если локального Order нет.
      const prior = await this._deps.submissions.get(input.orderId);
      if (
        prior &&
        (prior.status === 'COMMITTED' || prior.status === 'VENUE_ACCEPTED') &&
        prior.venueOrderId && String(prior.venueOrderId) === String(venueOrderId)
      ) {
        this._logger.error('Save conflict + submission COMMITTED/VENUE_ACCEPTED but local Order missing — manual reconciliation, no cancel', {
          clientOrderId: String(input.orderId),
          venueOrderId: String(venueOrderId),
          priorStatus: prior.status,
        });
        await this._addReconciliationIssue({
          id: `reconciliation:submit:${String(venueOrderId)}:save-conflict-no-local-order`,
          type: 'VENUE_LOCAL_ORDER_DESYNC',
          status: 'OPEN',
          reason: `SAVE_CONFLICT_SUBMISSION_${prior.status}_NO_LOCAL_ORDER`,
          createdAt: this._deps.clock.now(),
          orderId: venueOrderId,
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          context: { clientOrderId: String(input.orderId), priorStatus: prior.status },
        });
        return Err(new TradingError(
          `Save conflict with own submission but local Order missing: ${String(input.orderId)}`,
          { context: { venueOrderId: String(venueOrderId) } },
        ));
      }
      // Конфликт от ЧУЖОЙ записи (не наш ордер, локальный Order отсутствует) —
      // безопасный cancel policy: cancel → release только после подтверждения.
      await this._rollbackPostSubmit({
        venueOrderId,
        attempt,
        stage: 'save-conflict-rollback',
        clientOrderId: input.orderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        transportErrorMessage: 'Failed to cancel exchange order after save conflict — venue order may still be live, manual reconciliation required',
        releaseReservation: releaseOrderReservation,
      });
      // События НЕ публикуем — локально ордер не сохранён.
      return Err(new TradingError(
        `Failed to save order due to version conflict: ${saveResult.error.message}`,
        { context: { venueOrderId: String(venueOrderId) } },
      ));
    }

    // Order сохранён локально — фиксируем committed submission. Сбой
    // markCommitted — critical partial commit (guard/order desync): создаётся
    // blocking issue, но business state committed → Ok (см. _safeMarkCommitted).
    await this._safeMarkCommitted(input, venueOrderId);

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

    // Шаг 7: ENQUEUE событий в ordered outbox — ВНУТРИ lock (после save+markers+issues).
    // НЕ публикуем под lock (это дренировало бы handlers синхронно → deadlock,
    // если handler ORDER_ACCEPTED вызывает lock-зависимый use-case). Outbox
    // сохраняет per-order FIFO: publishAll (в execute() после lock) опубликует
    // Place-события раньше Fill-событий того же ордера, потому что Place enqueue-ит
    // раньше (keyed mutex сериализует Place перед Fill).
    // Сбой enqueue НЕ откатывает committed place (Ok сохраняется) — helper
    // логирует EVENT_PUBLISH_FAILED и создаёт issue.
    const events = acceptedOrder.pullEvents(() => this._deps.metadataGenerator.nextRoot());
    await enqueueCommittedEvents({
      outbox: this._deps.orderedEventOutbox,
      logger: this._logger,
      reconciliationIssues: this._deps.reconciliationIssues,
      now: this._deps.clock.now(),
      aggregateId: String(venueOrderId),
      events: events as readonly unknown[],
      issueContext: {
        issueId: `reconciliation:submit:${String(venueOrderId)}:outbox-enqueue-failed`,
        stage: 'outbox-enqueue',
        orderId: venueOrderId,
        accountId: input.accountId,
        instrumentId: input.instrumentId,
        extra: { clientOrderId: String(input.orderId) },
      },
    });

    this._logger.info('Order placed successfully (events enqueued for flush after lock)', {
      venueOrderId: String(venueOrderId),
      clientOrderId: String(input.orderId),
      side: input.side,
      submitStatus: submitValue.status,
      ...(orderNotional !== undefined ? { notional: orderNotional.value().toString() } : { size: orderSize.value().toString() }),
    });

    return Ok({ venueOrderId });
  }
}
