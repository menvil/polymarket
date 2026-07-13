/**
 * PlaceOrderUseCase — оркестрация размещения нового торгового ордера.
 *
 * @remarks
 * ### Алгоритм (7 шагов):
 * 1. Пре-трейд риск-проверка (OrderRiskChecker)
 * 2. Резервирование баланса (portfolio.reserveForOrder)
 * 3. Отправка на биржу (exchangeClient.submitOrder) → типизированный SubmitOrderResult:
 *    - `Err(ExchangeError)` (транспорт): откат резервации, Err
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
 * 7. Публикация доменных событий — `eventBus.publishAll(order.pullEvents())`.
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
import type {
  IExchangeClient,
  IOrderRepository,
  IOrderStateStore,
  IReconciliationIssueRepository,
  ReconciliationIssue,
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
}

/** Ошибки PlaceOrderUseCase */
export type PlaceOrderError = TradingError | RiskViolationError;

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
   * Логирует исход best-effort venue-отмены в rollback-ветках.
   *
   * @param venueOrderId - ID ордера на бирже, для которого запрашивался rollback cancel
   * @param cancelResult - Результат `exchangeClient.cancelOrder()`
   * @param transportErrorMessage - Сообщение для лога, если cancelResult — Err (транспортная ошибка)
   *
   * @remarks
   * Не парсит `reason` из `CancelOrderResult` — только switch по типизированному `status`.
   * `CANCELLED` / `ALREADY_CANCELLED` / `NOT_FOUND` считаются завершённым или идемпотентным
   * rollback venue-стороны и не логируются как ошибка.
   */
  private _logRollbackCancelOutcome(
    venueOrderId: OrderId,
    cancelResult: Awaited<ReturnType<IExchangeClient['cancelOrder']>>,
    transportErrorMessage: string,
  ): void {
    if (!cancelResult.ok) {
      this._logger.error(transportErrorMessage, {
        venueOrderId: String(venueOrderId),
        error: cancelResult.error.message,
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
        break;
      case 'UNKNOWN_RETRY_NEEDED':
        this._logger.error(
          'Rollback cancel outcome unclear — venue order may still be live, manual reconciliation required',
          { venueOrderId: String(venueOrderId), reason: cancelResult.value.reason },
        );
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
    // Шаг 1: Пре-трейд риск-проверка
    const riskResult = this._deps.riskChecker.checkBeforeOrder({
      portfolio: input.portfolio,
      openOrdersCount: input.openOrdersCount,
      side: input.side,
      price: input.price,
      size: input.size,
      instrumentId: input.instrumentId,
      strategyId: input.strategyId,
    });
    if (!riskResult.ok) {
      this._logger.warn('Pre-trade risk check failed', {
        riskCode: riskResult.error.riskCode,
        clientOrderId: String(input.orderId),
      });
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
    const submitResult = await this._deps.exchangeClient.submitOrder({
      asset: input.asset,
      side: input.side,
      price: input.price,
      size: input.size,
      postOnly: input.postOnly,
      orderType: input.orderType,
      clientOrderId: input.orderId as unknown as string,
      strategyId: input.strategyId,
    } as any);

    if (!submitResult.ok) {
      // Откат: снять резервацию
      this._logger.warn('Exchange rejected order, rolling back reservation', {
        clientOrderId: String(input.orderId),
        error: submitResult.error.message,
      });
      const releaseResult = isBuy
        ? this._deps.portfolioService.releaseReservation(input.accountId, notional!)
        : this._deps.portfolioService.releaseTokenReservation(
            input.accountId,
            input.instrumentId,
            input.size.value(),
          );
      if (!releaseResult.ok) {
        this._logger.error('Failed to release reservation during rollback', {
          clientOrderId: String(input.orderId),
          releaseError: releaseResult.error.message,
        });
      }
      return Err(new TradingError(
        `Exchange submission failed: ${submitResult.error.message}`,
        {
          context: {
            clientOrderId: String(input.orderId),
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
      }
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
        this._logRollbackCancelOutcome(
          submitValue.orderId,
          cancelExchangeResult,
          'Failed to cancel exchange order after UNKNOWN submit result — venue order may still be live, manual reconciliation required',
        );
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
      }
      const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
      this._logRollbackCancelOutcome(
        venueOrderId,
        cancelExchangeResult,
        'Failed to cancel exchange order after invalid effectiveSize — venue order may still be live, manual reconciliation required',
      );
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
        const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
        this._logRollbackCancelOutcome(
          venueOrderId,
          cancelExchangeResult,
          'Failed to cancel exchange order after excess-release failure — venue order may still be live, manual reconciliation required',
        );
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
      }
      const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
      this._logRollbackCancelOutcome(
        venueOrderId,
        cancelExchangeResult,
        'Failed to cancel exchange order after timestamp failure — venue order may still be live, manual reconciliation required',
      );
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
      }
      const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
      this._logRollbackCancelOutcome(
        venueOrderId,
        cancelExchangeResult,
        'Failed to cancel exchange order after Order.create failure — venue order may still be live, manual reconciliation required',
      );
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
      }
      const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
      this._logRollbackCancelOutcome(
        venueOrderId,
        cancelExchangeResult,
        'Failed to cancel exchange order during accept() rollback',
      );
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
      // Ордер уже создан на venue — best-effort отмена, как в других rollback-ветках.
      const cancelExchangeResult = await this._deps.exchangeClient.cancelOrder(venueOrderId);
      this._logRollbackCancelOutcome(
        venueOrderId,
        cancelExchangeResult,
        'Failed to cancel exchange order after save conflict — venue order may still be live, manual reconciliation required',
      );
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
      }
      // События НЕ публикуем — локально ордер не сохранён.
      return Err(new TradingError(
        `Failed to save order due to version conflict: ${saveResult.error.message}`,
        { context: { venueOrderId: String(venueOrderId) } },
      ));
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

    // Шаг 7: Публикация событий
    const events = acceptedOrder.pullEvents();
    try {
      await this._deps.eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);
    } catch (err) {
      this._logger.error('Failed to publish order placed events', {
        venueOrderId: String(venueOrderId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return Err(new TradingError(
        `Failed to publish events: ${err instanceof Error ? err.message : String(err)}`,
        { context: { venueOrderId: String(venueOrderId) } },
      ));
    }

    this._logger.info('Order placed successfully', {
      venueOrderId: String(venueOrderId),
      clientOrderId: String(input.orderId),
      side: input.side,
      submitStatus: submitValue.status,
      ...(orderNotional !== undefined ? { notional: orderNotional.toString() } : { size: orderSize.value().toString() }),
    });

    return Ok(venueOrderId);
  }
}
