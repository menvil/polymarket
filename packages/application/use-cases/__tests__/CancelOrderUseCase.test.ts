import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CancelOrderUseCase } from '../src/CancelOrderUseCase.js';
import { PortfolioService } from '../src/services/PortfolioService.js';
import type { CancelOrderDeps, CancelOrderInput } from '../src/CancelOrderUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type {
  IOrderRepository,
  IPortfolioStore,
  IExchangeClient,
  IOrderStateStore,
  IKeyedMutex,
  InFlightFill,
  CancelOrderResult,
  IReconciliationIssueRepository,
  IOrderedEventOutbox,
} from '@polymarket/ports';
import { VersionConflictError } from '@polymarket/ports';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { AccountId, InstrumentId, OrderId } from '@polymarket/ids';
import { asPolymarketCtfToken } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import { Order } from '@polymarket/order';
import Decimal from 'decimal.js';
import { InMemoryOrderedEventOutbox } from '../../../infrastructure/in-memory/src/InMemoryOrderedEventOutbox.js';
import { InMemoryOrderSubmissionRepository } from '../../../infrastructure/in-memory/src/InMemoryOrderSubmissionRepository.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn<ILogger['child']>().mockReturnThis() as ILogger['child'],
  };
}

function makeEventBus(): IEventBus {
  return {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(Ok(undefined)),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(Ok(undefined)),
    subscribe: jest.fn<IEventBus['subscribe']>().mockReturnValue(() => {}),
  };
}

/** Реальный ordered outbox → публикует в eventBus на flush (assertions на publishAll живут). */
function makeOutbox(
  eventBus: IEventBus,
  reconciliationIssues?: IReconciliationIssueRepository,
): IOrderedEventOutbox {
  return new InMemoryOrderedEventOutbox({
    publish: async (events) => {
      const result = await eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);
      if (!result.ok) throw result.error;
    },
    logger: makeLogger(),
    reconciliationIssues,
  });
}

function makePrice(val: string): Price {
  return Price.of(new Decimal(val));
}

function makeQty(val: string): Quantity {
  return Quantity.of(new Decimal(val));
}

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;
const ASSET_ID = asPolymarketCtfToken('123')!;
const ORDER_ID = 'order-1' as unknown as OrderId;

function makeOpenOrder(): Order {
  const result = Order.create({
    id: ORDER_ID,
    asset: ASSET_ID,
    side: 'BUY',
    price: makePrice('0.65') as never,
    size: makeQty('100') as never,
    timestamp: { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '2024-01-01T00:00:00.000Z' } as never,
  });
  if (!result.ok) throw new Error('Failed to create Order');
  const accepted = result.value.accept();
  if (!accepted.ok) throw new Error('Failed to accept Order');
  accepted.value.pullEvents();
  return accepted.value;
}

function makePortfolioMock(): Portfolio {
  const p: Portfolio = {
    accountId: ACCOUNT_ID,
    balance: {
      available: () => ({ value: () => new Decimal('10000') }),
      reserved: () => ({ value: () => new Decimal('65') }),
      total: () => ({ value: () => new Decimal('10065') }),
    },
    version: 0,
    getPosition: (_id: InstrumentId) => undefined,
    getPositions: () => ([] as IPosition[]).values(),
    getPositionCount: () => 0,
    reserveForOrder: jest.fn<Portfolio['reserveForOrder']>(),
    releaseReservation: jest.fn<Portfolio['releaseReservation']>(),
    reserveTokensForOrder: jest.fn<Portfolio['reserveTokensForOrder']>(),
    releaseTokenReservation: jest.fn<Portfolio['releaseTokenReservation']>(),
    applyDebit: jest.fn<Portfolio['applyDebit']>(),
    applyCredit: jest.fn<Portfolio['applyCredit']>(),
    upsertPosition: jest.fn<Portfolio['upsertPosition']>(),
    tokenReservations: new Map(),
  } as unknown as Portfolio;
  (p.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.releaseTokenReservation as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  return p;
}

function makePortfolioStore(portfolio?: Portfolio): IPortfolioStore {
  const p = portfolio ?? makePortfolioMock();
  return {
    get: jest.fn<IPortfolioStore['get']>().mockReturnValue(p),
    save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
    getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
  };
}

function makeOrderRepo(order?: Order): IOrderRepository {
  return {
    get: jest.fn().mockImplementation(() => Promise.resolve(order)) as unknown as IOrderRepository['get'],
    getVersion: jest.fn().mockImplementation(() => Promise.resolve(order ? 1 : 0)) as unknown as IOrderRepository['getVersion'],
    getWithVersion: jest.fn().mockImplementation(() =>
      Promise.resolve(order ? { order, version: 1 } : undefined),
    ) as unknown as IOrderRepository['getWithVersion'],
    save: jest.fn().mockImplementation(() => Promise.resolve(Ok(undefined))) as unknown as IOrderRepository['save'],
    deleteIfVersion: jest.fn().mockImplementation(() => Promise.resolve(Ok({ status: 'DELETED' }))) as unknown as IOrderRepository['deleteIfVersion'],
    deleteIfState: jest.fn().mockImplementation(() => Promise.resolve(Ok({ status: 'DELETED' }))) as unknown as IOrderRepository['deleteIfState'],
    getByStrategyId: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getByStrategyId'],
    countByStrategyId: jest.fn().mockImplementation(() => Promise.resolve(0)) as unknown as IOrderRepository['countByStrategyId'],
    getAll: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getAll'],
    getByMarketId: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getByMarketId'],
  };
}

function makeOrderStateStore(
  order?: Order,
  matchedOrderIds: string[] = [],
  inFlightInstrumentIds: string[] = [],
): IOrderStateStore {
  const matched = new Set(matchedOrderIds);
  const inFlight = new Set(inFlightInstrumentIds);
  return {
    getOrder: jest.fn<IOrderStateStore['getOrder']>().mockReturnValue(order),
    saveSync: jest.fn<IOrderStateStore['saveSync']>(),
    getOpenOrders: jest.fn<IOrderStateStore['getOpenOrders']>().mockReturnValue([]),
    getOpenOrdersByInstrument: jest.fn<IOrderStateStore['getOpenOrdersByInstrument']>().mockReturnValue([]),
    markOrderFillMatched: jest.fn<IOrderStateStore['markOrderFillMatched']>(),
    clearOrderFillMatched: jest.fn<IOrderStateStore['clearOrderFillMatched']>(),
    hasMatchedFills: jest.fn<IOrderStateStore['hasMatchedFills']>().mockImplementation(
      (id) => matched.has(String(id)),
    ),
    getMatchedFillIds: jest.fn<IOrderStateStore['getMatchedFillIds']>().mockReturnValue([]),
    markInFlightFill: jest.fn<IOrderStateStore['markInFlightFill']>(),
    updateInFlightFillStatus: jest.fn<IOrderStateStore['updateInFlightFillStatus']>(),
    clearInFlightFill: jest.fn<IOrderStateStore['clearInFlightFill']>(),
    hasInFlightFills: jest.fn<IOrderStateStore['hasInFlightFills']>().mockImplementation(
      (id) => inFlight.has(String(id)),
    ),
    getInFlightFills: jest.fn<IOrderStateStore['getInFlightFills']>().mockReturnValue([] as readonly InFlightFill[]),
    markFillProcessing: jest.fn<IOrderStateStore['markFillProcessing']>(),
    updateFillProcessingStatus: jest.fn<IOrderStateStore['updateFillProcessingStatus']>(),
    clearFillProcessing: jest.fn<IOrderStateStore['clearFillProcessing']>(),
    hasFillProcessingBlocks: jest.fn<IOrderStateStore['hasFillProcessingBlocks']>().mockReturnValue(false),
    getFillProcessingBlocks: jest.fn<IOrderStateStore['getFillProcessingBlocks']>().mockReturnValue([]),
    // Stage 6: единый guard — venue in-flight ЛИБО processing-блок.
    hasUnsettledFills: jest.fn<IOrderStateStore['hasUnsettledFills']>().mockImplementation(
      (id) => inFlight.has(String(id)),
    ),
    markManualReconciliationBlock: jest.fn<IOrderStateStore['markManualReconciliationBlock']>(),
    clearManualReconciliationBlock: jest.fn<IOrderStateStore['clearManualReconciliationBlock']>(),
    hasManualReconciliationBlockForOrder: jest.fn<IOrderStateStore['hasManualReconciliationBlockForOrder']>().mockReturnValue(false),
    hasManualReconciliationBlocks: jest.fn<IOrderStateStore['hasManualReconciliationBlocks']>().mockReturnValue(false),
    getManualReconciliationBlocks: jest.fn<IOrderStateStore['getManualReconciliationBlocks']>().mockReturnValue([]),
    markTerminalSettlementPending: jest.fn<IOrderStateStore['markTerminalSettlementPending']>(),
    clearTerminalSettlementPending: jest.fn<IOrderStateStore['clearTerminalSettlementPending']>(),
    hasTerminalSettlementPendingForOrder: jest.fn<IOrderStateStore['hasTerminalSettlementPendingForOrder']>().mockReturnValue(false),
    hasTerminalSettlementPending: jest.fn<IOrderStateStore['hasTerminalSettlementPending']>().mockReturnValue(false),
    getTerminalSettlementPending: jest.fn<IOrderStateStore['getTerminalSettlementPending']>().mockReturnValue([]),
  };
}

function makeKeyedMutex(): IKeyedMutex {
  return {
    runExclusive: jest.fn(<T>(_keys: readonly string[], fn: () => Promise<T>) => fn()) as unknown as IKeyedMutex['runExclusive'],
  };
}

/** Exchange client с настраиваемым cancelOrder-исходом. */
function makeExchangeClient(
  cancel: CancelOrderResult | Error = { status: 'CANCELLED' } as CancelOrderResult,
): IExchangeClient {
  const cancelMock = cancel instanceof Error
    ? jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Err(cancel as never))
    : jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok(cancel));
  return {
    submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
      Ok({ status: 'OPEN', orderId: ORDER_ID, effectiveSize: makeQty('100'), remainingSize: makeQty('100') }),
    ),
    cancelOrder: cancelMock,
    getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
    getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
  };
}

function makeInput(overrides: Partial<CancelOrderInput> = {}): CancelOrderInput {
  return {
    orderId: ORDER_ID,
    accountId: ACCOUNT_ID,
    reason: 'User cancelled',
    ...overrides,
  };
}

function makeReconciliationIssueRepo(): IReconciliationIssueRepository {
  return {
    add: jest.fn<IReconciliationIssueRepository['add']>().mockResolvedValue(undefined),
    listOpen: jest.fn<IReconciliationIssueRepository['listOpen']>().mockResolvedValue([]),
    get: jest.fn<IReconciliationIssueRepository['get']>().mockResolvedValue(undefined),
    markResolved: jest.fn<IReconciliationIssueRepository['markResolved']>().mockResolvedValue(undefined),
  };
}

/** Извлекает issue-объекты, переданные в reconciliationIssues.add. */
function addedIssues(repo: IReconciliationIssueRepository): Array<{ id: string; type: string; reason: string; context?: Record<string, unknown> }> {
  return (repo.add as ReturnType<typeof jest.fn>).mock.calls.map((c) => c[0] as { id: string; type: string; reason: string; context?: Record<string, unknown> });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CancelOrderUseCase (venue-first)', () => {
  let logger: ILogger;
  let eventBus: IEventBus;
  let orderRepo: IOrderRepository;
  let orderStateStore: IOrderStateStore;
  let portfolio: Portfolio;
  let portfolioStore: IPortfolioStore;
  let exchangeClient: IExchangeClient;
  let keyedMutex: IKeyedMutex;
  let submissions: InMemoryOrderSubmissionRepository;
  let deps: CancelOrderDeps;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    const order = makeOpenOrder();
    orderRepo = makeOrderRepo(order);
    orderStateStore = makeOrderStateStore(order);
    portfolio = makePortfolioMock();
    portfolioStore = makePortfolioStore(portfolio);
    exchangeClient = makeExchangeClient({ status: 'CANCELLED' } as CancelOrderResult);
    keyedMutex = makeKeyedMutex();
    submissions = new InMemoryOrderSubmissionRepository();

    const portfolioService = new PortfolioService(portfolioStore, logger);

    deps = {
      portfolioService,
      orderRepo,
      orderStateStore,
      keyedMutex,
      exchangeClient,
      orderedEventOutbox: makeOutbox(eventBus),
      submissions,
      logger,
    };
  });

  // ── Confirmed cancel (CANCELLED / ALREADY_CANCELLED) ───────────────────────

  it('CANCELLED → Ok(CANCELLED), сохраняет отменённый Order, release, публикует события', async () => {
    const useCase = new CancelOrderUseCase(deps);
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('CANCELLED');
    expect(orderRepo.save).toHaveBeenCalled();
    expect(portfolio.releaseReservation).toHaveBeenCalled();
    expect(eventBus.publishAll).toHaveBeenCalled();
  });

  it('вызывает cancelOrder на бирже с ORDER_ID', async () => {
    const useCase = new CancelOrderUseCase(deps);
    await useCase.execute(makeInput());
    expect(exchangeClient.cancelOrder).toHaveBeenCalledWith(ORDER_ID);
  });

  it('venue-first: cancelOrder вызывается ДО orderRepo.save', async () => {
    const callOrder: string[] = [];
    (exchangeClient.cancelOrder as ReturnType<typeof jest.fn>).mockImplementation(async () => {
      callOrder.push('venue-cancel');
      return Ok({ status: 'CANCELLED' } as CancelOrderResult);
    });
    (orderRepo.save as ReturnType<typeof jest.fn>).mockImplementation(async () => {
      callOrder.push('local-save');
      return Ok(undefined);
    });
    const useCase = new CancelOrderUseCase(deps);
    await useCase.execute(makeInput());
    expect(callOrder).toEqual(['venue-cancel', 'local-save']);
  });

  it('ALREADY_CANCELLED → Ok(ALREADY_CANCELLED), локальный commit + release', async () => {
    exchangeClient = makeExchangeClient({ status: 'ALREADY_CANCELLED' } as CancelOrderResult);
    const useCase = new CancelOrderUseCase({ ...deps, exchangeClient });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('ALREADY_CANCELLED');
    expect(orderRepo.save).toHaveBeenCalled();
    expect(portfolio.releaseReservation).toHaveBeenCalled();
  });

  it('CANCELLED (чистый исход) — reconciliation issue НЕ создаётся', async () => {
    const reconciliationIssues = makeReconciliationIssueRepo();
    const useCase = new CancelOrderUseCase({ ...deps, reconciliationIssues });
    await useCase.execute(makeInput());
    expect(reconciliationIssues.add).not.toHaveBeenCalled();
  });

  it('journal: подтверждённый cancel освобождает остаток резервации (release → SETTLED)', async () => {
    // Seed held reservation под venueOrderId=ORDER_ID.
    const CLIENT = 'client-1' as unknown as OrderId;
    await submissions.begin({
      clientOrderId: CLIENT, accountId: ACCOUNT_ID, instrumentId: '123' as unknown as InstrumentId,
      fingerprint: 'fp', side: 'BUY', orderPrice: '0.65', requestedSize: '100', now: new Date(),
    });
    await submissions.markReservationHeld(CLIENT, '65', new Date());
    await submissions.markVenueAccepted(CLIENT, ORDER_ID, new Date());

    const useCase = new CancelOrderUseCase(deps);
    await useCase.execute(makeInput());

    const record = await submissions.get(CLIENT);
    expect(record?.reservation).toMatchObject({ remaining: '0', released: '65', status: 'SETTLED' });
  });

  // ── ALREADY_FILLED (invariant 5: НЕ переводить в CANCELED) ──────────────────

  describe('ALREADY_FILLED', () => {
    beforeEach(() => {
      exchangeClient = makeExchangeClient({ status: 'ALREADY_FILLED', reason: 'matched' } as CancelOrderResult);
    });

    it('локальный Order НЕ отменяется (orderRepo.save не вызывается), резервация НЕ освобождается', async () => {
      const useCase = new CancelOrderUseCase({ ...deps, exchangeClient });
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('FILL_PENDING');
      expect(orderRepo.save).not.toHaveBeenCalled();
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    });

    it('ставит order-level matched + instrument-level in-flight placeholder', async () => {
      const useCase = new CancelOrderUseCase({ ...deps, exchangeClient });
      await useCase.execute(makeInput());
      expect(orderStateStore.markOrderFillMatched).toHaveBeenCalled();
      expect(orderStateStore.markInFlightFill).toHaveBeenCalled();
    });
  });

  // ── Uncertain outcomes (invariant 4: не подтверждение отмены) ───────────────

  describe('uncertain venue outcomes → RECONCILIATION_REQUIRED, reservation held', () => {
    for (const [status, slug] of [
      ['NOT_FOUND', 'not-found'],
      ['UNKNOWN_RETRY_NEEDED', 'unknown'],
    ] as const) {
      it(`${status} → RECONCILIATION_REQUIRED, НЕ cancel/release, issue ${slug} + instrument block`, async () => {
        const reconciliationIssues = makeReconciliationIssueRepo();
        exchangeClient = makeExchangeClient({ status, reason: 'x' } as CancelOrderResult);
        const useCase = new CancelOrderUseCase({ ...deps, exchangeClient, reconciliationIssues });
        const result = await useCase.execute(makeInput());

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.status).toBe('RECONCILIATION_REQUIRED');
        expect(orderRepo.save).not.toHaveBeenCalled();
        expect(portfolio.releaseReservation).not.toHaveBeenCalled();
        expect(orderStateStore.markInFlightFill).toHaveBeenCalled(); // instrument block
        const issue = addedIssues(reconciliationIssues).find((i) => i.type === 'CANCEL_UNKNOWN_OUTCOME');
        expect(issue?.id).toBe(`reconciliation:cancel:${String(ORDER_ID)}:${slug}`);
        expect(issue?.context).toMatchObject({ reservationHeld: true, localStatus: 'UNCHANGED' });
      });
    }

    it('транспортный Err → RECONCILIATION_REQUIRED, issue transport-error, НЕ cancel/release', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      exchangeClient = makeExchangeClient(new TradingError('bus down'));
      const useCase = new CancelOrderUseCase({ ...deps, exchangeClient, reconciliationIssues });
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('RECONCILIATION_REQUIRED');
      expect(orderRepo.save).not.toHaveBeenCalled();
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      const issue = addedIssues(reconciliationIssues).find((i) => i.type === 'CANCEL_UNKNOWN_OUTCOME');
      expect(issue?.id).toBe(`reconciliation:cancel:${String(ORDER_ID)}:transport-error`);
    });

    it('cancelOrder бросает исключение → трактуется как transport unknown (RECONCILIATION_REQUIRED)', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      exchangeClient = makeExchangeClient();
      (exchangeClient.cancelOrder as ReturnType<typeof jest.fn>).mockImplementation(() => {
        throw new Error('boom');
      });
      const useCase = new CancelOrderUseCase({ ...deps, exchangeClient, reconciliationIssues });
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('RECONCILIATION_REQUIRED');
      expect(orderRepo.save).not.toHaveBeenCalled();
      const issue = addedIssues(reconciliationIssues).find((i) => i.type === 'CANCEL_UNKNOWN_OUTCOME');
      expect(issue?.id).toBe(`reconciliation:cancel:${String(ORDER_ID)}:transport-error`);
    });

    it('сбой reconciliationIssues.add логируется, но результат остаётся Ok', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      (reconciliationIssues.add as ReturnType<typeof jest.fn>).mockRejectedValue(new Error('store down') as never);
      exchangeClient = makeExchangeClient({ status: 'NOT_FOUND', reason: 'x' } as CancelOrderResult);
      const useCase = new CancelOrderUseCase({ ...deps, exchangeClient, reconciliationIssues });
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(true);
    });
  });

  // ── Local guards (перед venue) ─────────────────────────────────────────────

  it('терминальный Order → Ok(ALREADY_CANCELLED), venue cancel НЕ вызывается', async () => {
    const order = makeOpenOrder();
    const cancelled = order.cancel();
    const terminalOrder = cancelled.ok ? cancelled.value : order;
    orderRepo = makeOrderRepo(terminalOrder);
    const useCase = new CancelOrderUseCase({ ...deps, orderRepo });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('ALREADY_CANCELLED');
    expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
  });

  it('matched fills → FILL_PENDING, venue cancel НЕ вызывается, save НЕ вызывается', async () => {
    const order = makeOpenOrder();
    orderStateStore = makeOrderStateStore(order, [String(ORDER_ID)]);
    const useCase = new CancelOrderUseCase({ ...deps, orderStateStore });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('FILL_PENDING');
    expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  it('in-flight fill на инструменте → FILL_PENDING, venue cancel НЕ вызывается', async () => {
    const order = makeOpenOrder();
    orderStateStore = makeOrderStateStore(order, [], ['123']);
    const useCase = new CancelOrderUseCase({ ...deps, orderStateStore });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('FILL_PENDING');
    expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
  });

  it('ордер не найден (preflight) → Err', async () => {
    orderRepo = makeOrderRepo(undefined);
    const useCase = new CancelOrderUseCase({ ...deps, orderRepo });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(false);
  });

  // ── CAS save conflict после подтверждённого venue cancel ───────────────────

  describe('CAS save conflict после venue CANCELLED', () => {
    beforeEach(() => {
      (orderRepo.save as ReturnType<typeof jest.fn>).mockImplementation(() =>
        Promise.resolve(Err(new VersionConflictError(String(ORDER_ID), 0, 1))),
      );
    });

    it('reread терминальный → Ok(ALREADY_CANCELLED), без release', async () => {
      const order = makeOpenOrder();
      const cancelled = order.cancel();
      const terminal = cancelled.ok ? cancelled.value : order;
      (orderRepo.get as ReturnType<typeof jest.fn>).mockResolvedValue(terminal as never);
      const useCase = new CancelOrderUseCase(deps);
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('ALREADY_CANCELLED');
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    });

    it('reread исчез → Ok(ALREADY_CANCELLED), без release', async () => {
      // getWithVersion вернёт order (для commit), но повторный get → undefined.
      let call = 0;
      (orderRepo.get as ReturnType<typeof jest.fn>).mockImplementation(() => {
        call += 1;
        return Promise.resolve(call === 1 ? makeOpenOrder() : undefined);
      });
      const useCase = new CancelOrderUseCase(deps);
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('ALREADY_CANCELLED');
    });

    it('reread не терминальный → VENUE_LOCAL_ORDER_DESYNC issue + RECONCILIATION_REQUIRED, без release', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      (orderRepo.get as ReturnType<typeof jest.fn>).mockResolvedValue(makeOpenOrder() as never);
      const useCase = new CancelOrderUseCase({ ...deps, reconciliationIssues });
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('RECONCILIATION_REQUIRED');
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      const issue = addedIssues(reconciliationIssues).find((i) => i.type === 'VENUE_LOCAL_ORDER_DESYNC');
      expect(issue?.id).toBe(`reconciliation:cancel:${String(ORDER_ID)}:venue-cancelled-local-save-conflict`);
    });
  });

  // ── Release failure после подтверждённого cancel ───────────────────────────

  it('сбой release после committed CANCELED → Ok(RECONCILIATION_REQUIRED), issue reservation-release-failed, события всё равно enqueued', async () => {
    (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
      Err(new TradingError('cannot unfreeze')),
    );
    const reconciliationIssues = makeReconciliationIssueRepo();
    const useCase = new CancelOrderUseCase({ ...deps, reconciliationIssues });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    // Этап 5.1: сбой Portfolio release больше НЕ считается подтверждённой
    // отменой — business cancel committed, но capital desync требует реконсиляции.
    if (result.ok) expect(result.value.status).toBe('RECONCILIATION_REQUIRED');
    const issue = addedIssues(reconciliationIssues).find((i) => i.id.endsWith(':reservation-release-failed'));
    expect(issue?.type).toBe('ORDER_PORTFOLIO_DESYNC');
    expect(eventBus.publishAll).toHaveBeenCalled();
  });

  // ── Publish (flush) failure после commit ───────────────────────────────────

  it('сбой publish (flush) после commit → Ok(CANCELLED), EVENT_PUBLISH_FAILED issue (создаёт outbox)', async () => {
    const failingBus = makeEventBus();
    (failingBus.publishAll as ReturnType<typeof jest.fn>).mockRejectedValue(new Error('bus down') as never);
    const reconciliationIssues = makeReconciliationIssueRepo();
    const useCase = new CancelOrderUseCase({
      ...deps,
      orderedEventOutbox: makeOutbox(failingBus, reconciliationIssues),
    });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('CANCELLED');
    const issue = addedIssues(reconciliationIssues).find((i) => i.type === 'EVENT_PUBLISH_FAILED');
    expect(issue).toBeDefined();
  });

  // ── Concurrency / lock keys ────────────────────────────────────────────────

  it('сериализует конкурентные execute() через keyedMutex.runExclusive с namespaced ключами', async () => {
    const callOrder: string[] = [];
    const realMutexKeys: string[][] = [];
    const trackingMutex = {
      runExclusive: jest.fn(async (keys: readonly string[], fn: () => Promise<unknown>) => {
        realMutexKeys.push([...keys]);
        callOrder.push('acquire');
        const result = await fn();
        callOrder.push('release');
        return result;
      }),
    } as unknown as IKeyedMutex;
    const useCase = new CancelOrderUseCase({ ...deps, keyedMutex: trackingMutex });
    await useCase.execute(makeInput());
    expect(trackingMutex.runExclusive).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['acquire', 'release']);
    expect(realMutexKeys[0]).toContain(`order:${String(ORDER_ID)}`);
  });

  // ── Terminal outcome mapping (Шаг 6) ─────────────────────────────────────────

  describe('terminal outcome mapping (Шаг 6)', () => {
    function makeTerminalOrderRepo(status: string): IOrderRepository {
      const terminalOrder = { id: ORDER_ID, asset: ASSET_ID, side: 'BUY', status, isTerminal: true } as unknown as Order;
      return {
        ...makeOrderRepo(terminalOrder),
        getWithVersion: jest.fn<IOrderRepository['getWithVersion']>().mockResolvedValue({ order: terminalOrder, version: 1 }),
      } as unknown as IOrderRepository;
    }

    it.each([
      ['CANCELED', 'ALREADY_CANCELLED'],
      ['FILLED', 'ALREADY_FILLED'],
      ['REJECTED', 'ALREADY_TERMINAL'],
      ['EXPIRED', 'ALREADY_TERMINAL'],
    ])('terminal Order %s → outcome %s (venue-запрос не выполняется)', async (orderStatus, expectedOutcome) => {
      const useCase = new CancelOrderUseCase({ ...deps, orderRepo: makeTerminalOrderRepo(orderStatus) });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe(expectedOutcome);
        if (result.value.status === 'ALREADY_TERMINAL') {
          expect(result.value.orderStatus).toBe(orderStatus);
        }
      }
      expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    });
  });

  // ── Portfolio↔journal синхронизация (Этап 5) ─────────────────────────────────

  describe('Portfolio↔journal sync (Этап 5)', () => {
    const CLIENT_ID = 'client-1' as unknown as OrderId;

    /** Seed журнала: held BUY-резервация под venueOrderId=ORDER_ID. */
    async function seedJournal(initial = '65'): Promise<void> {
      await submissions.begin({
        clientOrderId: CLIENT_ID,
        accountId: ACCOUNT_ID,
        instrumentId: '123' as unknown as InstrumentId,
        fingerprint: 'fp',
        side: 'BUY',
        orderPrice: '0.65',
        requestedSize: '100',
        now: new Date(),
      });
      await submissions.markReservationHeld(CLIENT_ID, initial, new Date());
      await submissions.markCommitted(CLIENT_ID, ORDER_ID, new Date());
    }

    it('Portfolio release failure: journal НЕ SETTLED (RECONCILIATION_REQUIRED), outcome RECONCILIATION_REQUIRED, block поставлен', async () => {
      await seedJournal();
      (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('cannot unfreeze')),
      );
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new CancelOrderUseCase({ ...deps, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('RECONCILIATION_REQUIRED');
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation.status).toBe('RECONCILIATION_REQUIRED');
      expect(record?.reservation.status).not.toBe('SETTLED');
      // Блокирующий instrument-marker поставлен.
      expect(orderStateStore.markManualReconciliationBlock).toHaveBeenCalled();
    });

    it('успешный Portfolio release → journal release: оба SETTLED, outcome CANCELLED', async () => {
      await seedJournal();
      const useCase = new CancelOrderUseCase(deps);

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('CANCELLED');
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation).toMatchObject({ status: 'SETTLED', remaining: '0', released: '65' });
    });

    it('journal release failure после успешного Portfolio release: issue создана, block сохранён, outcome RECONCILIATION_REQUIRED', async () => {
      // Стаб журнала: запись найдена (held), но transition падает.
      const { ReservationTransitionError, emptyReservation } = await import('@polymarket/ports');
      const heldRecord = {
        clientOrderId: CLIENT_ID,
        venueOrderId: ORDER_ID,
        status: 'COMMITTED',
        accountId: ACCOUNT_ID,
        instrumentId: '123' as unknown as InstrumentId,
        attempt: 1,
        fingerprint: 'fp',
        side: 'BUY',
        orderPrice: '0.65',
        requestedSize: '100',
        reservation: { ...emptyReservation('USDC'), initial: '65', remaining: '65', status: 'HELD' },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const failingSubmissions = {
        ...submissions,
        findByVenueOrderId: jest.fn().mockImplementation(async () => heldRecord),
        applyReservationTransition: jest.fn().mockImplementation(async () =>
          Err(new ReservationTransitionError('INVARIANT_VIOLATION', 'journal write failed')),
        ),
      } as unknown as CancelOrderDeps['submissions'];
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new CancelOrderUseCase({ ...deps, submissions: failingSubmissions, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('RECONCILIATION_REQUIRED');
      const issue = addedIssues(reconciliationIssues).find((i) => i.id.endsWith(':journal-release-failed'));
      expect(issue?.type).toBe('RESERVATION_JOURNAL_DESYNC');
      expect(orderStateStore.markManualReconciliationBlock).toHaveBeenCalled();
    });

    it('non-terminal CAS conflict после venue CANCELLED → manual block поставлен (P1)', async () => {
      // Venue подтвердил cancel, но CAS save конфликтует и reread показывает
      // всё ещё non-terminal ордер: venue-ордер мёртв, local OPEN, резервация
      // held — без manual block последующая торговля ничем не ограничена.
      const openLatest = makeOpenOrder();
      const conflictingRepo: IOrderRepository = {
        ...makeOrderRepo(makeOpenOrder()),
        save: jest.fn<IOrderRepository['save']>().mockResolvedValue(
          Err(new VersionConflictError(String(ORDER_ID), 1, 2)),
        ),
        get: jest.fn<IOrderRepository['get']>().mockResolvedValue(openLatest),
      } as unknown as IOrderRepository;
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new CancelOrderUseCase({ ...deps, orderRepo: conflictingRepo, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('RECONCILIATION_REQUIRED');
      expect(orderStateStore.markManualReconciliationBlock).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER_ID }),
      );
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    });

    it('order.cancel() failure после подтверждённого venue cancel → Err, manual block, VENUE_LOCAL_ORDER_DESYNC issue (P1)', async () => {
      // Fake Order: domain cancel() падает при живом (non-terminal) статусе.
      const brokenOrder = {
        id: ORDER_ID,
        asset: ASSET_ID,
        side: 'BUY',
        status: 'OPEN',
        isTerminal: false,
        cancel: () => Err(new TradingError('domain invariant violation')),
      } as unknown as Order;
      const brokenRepo: IOrderRepository = {
        ...makeOrderRepo(brokenOrder),
        getWithVersion: jest.fn<IOrderRepository['getWithVersion']>().mockResolvedValue({ order: brokenOrder, version: 1 }),
      } as unknown as IOrderRepository;
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new CancelOrderUseCase({ ...deps, orderRepo: brokenRepo, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(orderStateStore.markManualReconciliationBlock).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER_ID }),
      );
      const issue = addedIssues(reconciliationIssues).find((i) => i.id.endsWith(':venue-cancelled-local-cancel-failed'));
      expect(issue?.type).toBe('VENUE_LOCAL_ORDER_DESYNC');
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    });

    it('outbox enqueue Err: business cancel остаётся committed, EVENT_PUBLISH_FAILED issue', async () => {
      const { OutboxEnqueueError } = await import('@polymarket/ports');
      const reconciliationIssues = makeReconciliationIssueRepo();
      const failingOutbox = {
        enqueue: jest.fn().mockImplementation(async () => Err(new OutboxEnqueueError('queue full'))),
        flush: jest.fn().mockImplementation(async () => undefined),
      } as unknown as IOrderedEventOutbox;
      const useCase = new CancelOrderUseCase({ ...deps, orderedEventOutbox: failingOutbox, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      // Cancel committed (venue подтвердил + CAS save) — outcome CANCELLED.
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('CANCELLED');
      expect(orderRepo.save).toHaveBeenCalled();
      const issue = addedIssues(reconciliationIssues).find((i) => i.type === 'EVENT_PUBLISH_FAILED');
      expect(issue).toBeDefined();
      expect(issue!.reason).toContain('queue full');
    });
  });
});
