/**
 * Интеграционные тесты discovery + ручного разрешения UNKNOWN submissions
 * (safety-first итерация).
 *
 * @remarks
 * Fail-closed инварианты:
 * - discovery НИКОГДА автоматически не bind-ит и не release-ит (эвристика —
 *   подсказка, пустой venue-ответ — не доказательство отсутствия);
 * - manual block снимается только после завершённого recovery;
 * - explicit операторская резолюция — единственный путь bind/release.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import Decimal from 'decimal.js';
import { Ok, Err } from '@polymarket/result';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { IEventBus } from '@polymarket/event-bus';
import type {
  IExchangeClient,
  IKeyedMutex,
  IPortfolioStore,
  IProcessedFillRepository,
  IOrderedEventOutbox,
  IReconciliationIssueRepository,
  OpenOrderSnapshot,
  VenueTradeSnapshot,
} from '@polymarket/ports';
import { ExchangeError, ReservationTransitionError } from '@polymarket/ports';
import type { AccountId, AssetId, FillId, InstrumentId, MarketId, OrderId } from '@polymarket/ids';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { IOrderRiskChecker } from '@polymarket/risk';
import type { Fill } from '@polymarket/fill';
import { Price, Quantity } from '@polymarket/value-objects';
import { PlaceOrderUseCase } from '../../src/PlaceOrderUseCase.js';
import { ProcessFillUseCase } from '../../src/ProcessFillUseCase.js';
import { ReconcileUnknownSubmissionsUseCase } from '../../src/ReconcileUnknownSubmissionsUseCase.js';
import { ResolveUnknownSubmissionUseCase } from '../../src/ResolveUnknownSubmissionUseCase.js';
import { PortfolioService } from '../../src/services/PortfolioService.js';
import { LedgerService } from '../../src/services/LedgerService.js';
import { InMemoryOrderRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderRepository.js';
import { InMemoryOrderSubmissionRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderSubmissionRepository.js';
import { InMemoryOrderedEventOutbox } from '../../../../infrastructure/in-memory/src/InMemoryOrderedEventOutbox.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;
const ASSET_ID = { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'token-abc' } as unknown as AssetId;
const INSTRUMENT_ID = 'token-abc' as unknown as InstrumentId;
const CLIENT_ID = 'client-1' as unknown as OrderId;
const VENUE_ID = 'venue-1' as unknown as OrderId;
const TRADE_FILL_ID = 'venue-fill-1' as unknown as FillId;
const NOW = new Date('2026-01-01T00:00:00.000Z');

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
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
    subscribe: jest.fn<IEventBus['subscribe']>().mockReturnValue(() => {}),
  };
}

function makeOutbox(bus: IEventBus): IOrderedEventOutbox {
  return new InMemoryOrderedEventOutbox({
    publish: (events) => bus.publishAll(events as Parameters<IEventBus['publishAll']>[0]),
    logger: makeLogger(),
  });
}

function makeKeyedMutex(): IKeyedMutex {
  return {
    runExclusive: jest.fn(<T>(_keys: readonly string[], fn: () => Promise<T>) => fn()) as unknown as IKeyedMutex['runExclusive'],
  };
}

function makePortfolioMock(): Portfolio {
  const p: Portfolio = {
    accountId: ACCOUNT_ID,
    balance: {
      available: () => ({ value: () => new Decimal('10000') }),
      reserved: () => ({ value: () => new Decimal('65') }),
      total: () => ({ value: () => new Decimal('10065') }),
    },
    getPosition: (_id: InstrumentId) => undefined,
    getPositions: () => ([] as IPosition[]).values(),
    getPositionCount: () => 0,
    reserveForOrder: jest.fn<Portfolio['reserveForOrder']>(),
    releaseReservation: jest.fn<Portfolio['releaseReservation']>(),
    reserveTokensForOrder: jest.fn<Portfolio['reserveTokensForOrder']>(),
    releaseTokenReservation: jest.fn<Portfolio['releaseTokenReservation']>(),
    applyDebit: jest.fn<Portfolio['applyDebit']>(),
    applyCredit: jest.fn<Portfolio['applyCredit']>(),
    applyDirectDebit: jest.fn<Portfolio['applyDirectDebit']>(),
    upsertPosition: jest.fn<Portfolio['upsertPosition']>(),
    tokenReservations: new Map(),
  } as unknown as Portfolio;
  (p.reserveForOrder as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.releaseTokenReservation as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.applyDebit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.applyCredit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.applyDirectDebit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.upsertPosition as ReturnType<typeof jest.fn>).mockReturnValue(p);
  return p;
}

function makePortfolioStore(portfolio: Portfolio): IPortfolioStore {
  return {
    get: jest.fn<IPortfolioStore['get']>().mockReturnValue(portfolio),
    save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
    getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
  };
}

/** Stateful idempotency-репозиторий: FAILED → retry, APPLIED → DUPLICATE. */
function makeStatefulProcessedFillRepo(): IProcessedFillRepository {
  const status = new Map<string, 'PROCESSING' | 'APPLIED' | 'FAILED' | 'RECONCILIATION_REQUIRED'>();
  return {
    begin: jest.fn(async (fillId: FillId) => {
      const s = status.get(String(fillId));
      if (s === 'APPLIED') return { outcome: 'DUPLICATE' as const };
      if (s === 'RECONCILIATION_REQUIRED') return { outcome: 'RECONCILIATION_REQUIRED' as const };
      const isRetry = s === 'FAILED';
      status.set(String(fillId), 'PROCESSING');
      return { outcome: 'ACQUIRED' as const, isRetry };
    }),
    markApplied: jest.fn(async (fillId: FillId) => { status.set(String(fillId), 'APPLIED'); }),
    markFailed: jest.fn(async (fillId: FillId) => { status.set(String(fillId), 'FAILED'); }),
    markReverted: jest.fn(async () => undefined),
    markReconciliationRequired: jest.fn(async (fillId: FillId) => { status.set(String(fillId), 'RECONCILIATION_REQUIRED'); }),
    getStatus: jest.fn(async (fillId: FillId) => status.get(String(fillId))),
  } as unknown as IProcessedFillRepository;
}

function makeRiskChecker(): IOrderRiskChecker {
  return {
    checkBeforeOrder: jest.fn<IOrderRiskChecker['checkBeforeOrder']>().mockReturnValue(Ok(undefined)),
    updateParams: jest.fn<IOrderRiskChecker['updateParams']>(),
  };
}

function makeReconciliationIssueRepo(): IReconciliationIssueRepository {
  const issues = new Map<string, unknown>();
  return {
    add: jest.fn(async (issue: { id: string }) => { if (!issues.has(issue.id)) issues.set(issue.id, issue); }),
    listOpen: jest.fn(async () => [...issues.values()]),
    get: jest.fn(async (id: string) => issues.get(id)),
    markResolved: jest.fn(async () => undefined),
  } as unknown as IReconciliationIssueRepository;
}

function makeOpenOrderSnapshot(orderId: OrderId, overrides: Partial<OpenOrderSnapshot> = {}): OpenOrderSnapshot {
  return {
    orderId,
    accountId: ACCOUNT_ID,
    asset: ASSET_ID,
    side: 'BUY',
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
    filledSize: Quantity.of(new Decimal('0.01')),
    status: 'OPEN',
    createdAt: { toNumber: () => NOW.getTime() + 1_000 } as never,
    ...overrides,
  } as OpenOrderSnapshot;
}

function makeTradeSnapshot(orderId: OrderId, overrides: Partial<VenueTradeSnapshot> = {}): VenueTradeSnapshot {
  return {
    fillId: TRADE_FILL_ID,
    orderId,
    accountId: ACCOUNT_ID,
    marketId: 'market-1' as unknown as MarketId,
    asset: ASSET_ID,
    side: 'BUY',
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('50')),
    fee: { amount: Quantity.of(new Decimal('0')), asset: 'USDC' } as never,
    executedAt: { toNumber: () => NOW.getTime() + 2_000 } as never,
    status: 'CONFIRMED',
    ...overrides,
  } as unknown as VenueTradeSnapshot;
}

function makeFill(id: string, size = '50'): Fill {
  return {
    id: id as unknown as FillId,
    orderId: VENUE_ID,
    accountId: ACCOUNT_ID,
    tokenId: ASSET_ID,
    settlementAssetId: 'USDC' as unknown as AssetId,
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal(size)),
    side: 'BUY',
    timestamp: { value: () => new Decimal(1000), toNumber: () => 1000 } as never,
    fee: { amount: { value: () => new Decimal(0) }, asset: 'USDC' as unknown as AssetId, isZero: () => true } as never,
    hasFee: () => false,
  } as unknown as Fill;
}

/** Exchange-стаб с настраиваемыми open orders/trades. */
function makeExchange(
  openOrders: readonly OpenOrderSnapshot[],
  trades: readonly VenueTradeSnapshot[],
  opts: { openOrdersOk?: boolean; tradesOk?: boolean } = {},
): IExchangeClient {
  return {
    submitOrder: jest.fn<IExchangeClient['submitOrder']>(),
    cancelOrder: jest.fn<IExchangeClient['cancelOrder']>(),
    getOpenOrders: (opts.openOrdersOk ?? true)
      ? jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([...openOrders]))
      : jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Err(new ExchangeError('open orders api down'))),
    getTrades: (opts.tradesOk ?? true)
      ? jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([...trades]))
      : jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Err(new ExchangeError('trades api down'))),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Unknown submissions: discovery-only + operator resolution (safety-first)', () => {
  let logger: ILogger;
  let eventBus: IEventBus;
  let clock: IClock;
  let store: InMemoryOrderRepository;
  let submissions: InMemoryOrderSubmissionRepository;
  let portfolio: Portfolio;
  let portfolioService: PortfolioService;
  let ledgerService: LedgerService;
  let ledgerSpy: ReturnType<typeof jest.spyOn>;
  let processedFillRepo: IProcessedFillRepository;
  let reconciliationIssues: IReconciliationIssueRepository;
  let nowMs: number;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    nowMs = NOW.getTime();
    clock = { now: jest.fn(() => new Date(nowMs)) };
    store = new InMemoryOrderRepository();
    submissions = new InMemoryOrderSubmissionRepository();
    portfolio = makePortfolioMock();
    portfolioService = new PortfolioService(makePortfolioStore(portfolio), logger);
    ledgerService = new LedgerService(makeLogger());
    ledgerSpy = jest.spyOn(ledgerService as unknown as { recordFill: (f: Fill) => void }, 'recordFill')
      .mockReturnValue(undefined);
    processedFillRepo = makeStatefulProcessedFillRepo();
    reconciliationIssues = makeReconciliationIssueRepo();
  });

  function makeDiscovery(exchange: IExchangeClient): ReconcileUnknownSubmissionsUseCase {
    return new ReconcileUnknownSubmissionsUseCase({
      submissions, exchangeClient: exchange, clock, logger, reconciliationIssues,
    });
  }

  function makeResolver(exchange: IExchangeClient): ResolveUnknownSubmissionUseCase {
    return new ResolveUnknownSubmissionUseCase({
      submissions,
      exchangeClient: exchange,
      portfolioService,
      orderStateStore: store,
      keyedMutex: makeKeyedMutex(),
      clock,
      logger,
      reconciliationIssues,
    });
  }

  function makeProcessFill(): ProcessFillUseCase {
    return new ProcessFillUseCase({
      orderStateStore: store,
      portfolioService,
      ledgerService,
      orderRepo: store,
      processedFillRepo,
      keyedMutex: makeKeyedMutex(),
      eventBus,
      orderedEventOutbox: makeOutbox(eventBus),
      submissions,
      logger,
      clock,
    });
  }

  async function placeAmbiguous(): Promise<void> {
    const exchangeClient: IExchangeClient = {
      ...makeExchange([], []),
      submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
        Err(new ExchangeError('network timeout', { submitOutcome: 'MAY_HAVE_BEEN_SUBMITTED' })),
      ),
    };
    const place = new PlaceOrderUseCase({
      riskChecker: makeRiskChecker(),
      orderRepo: store,
      portfolioService,
      exchangeClient,
      orderStateStore: store,
      keyedMutex: makeKeyedMutex(),
      orderedEventOutbox: makeOutbox(eventBus),
      clock,
      logger,
      reconciliationIssues,
      submissions,
    });
    const result = await place.execute({
      orderId: CLIENT_ID,
      accountId: ACCOUNT_ID,
      asset: ASSET_ID,
      instrumentId: INSTRUMENT_ID,
      side: 'BUY',
      price: Price.of(new Decimal('0.65')),
      size: Quantity.of(new Decimal('100')),
      portfolio,
      openOrdersCount: 0,
    });
    expect(result.ok).toBe(false);
  }

  /** Проверяет, что состояние осталось fail-closed (held + UNKNOWN + block). */
  async function expectStillHeldAndBlocked(): Promise<void> {
    const record = await submissions.get(CLIENT_ID);
    expect(record?.status).toBe('UNKNOWN');
    expect(record?.venueOrderId).toBeUndefined();
    expect(record?.reservation).toMatchObject({ status: 'HELD', remaining: '65' });
    expect(store.hasManualReconciliationBlockForOrder(CLIENT_ID)).toBe(true);
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
  }

  // ── Discovery: никаких автоматических решений ────────────────────────────

  it('один эвристический open-order кандидат НЕ вызывает bind (только finding + issue)', async () => {
    await placeAmbiguous();
    const discovery = makeDiscovery(makeExchange([makeOpenOrderSnapshot(VENUE_ID)], []));

    const r = await discovery.execute({ accountId: ACCOUNT_ID });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({ scanned: 1, candidatesFound: 1, ambiguous: 0, noCandidates: 0, incomplete: 0 });
      expect(r.value.findings[0]).toMatchObject({ outcome: 'HEURISTIC_CANDIDATE_FOUND' });
      expect(r.value.findings[0].candidates[0]).toMatchObject({ kind: 'OPEN_ORDER', venueOrderId: VENUE_ID });
    }
    await expectStillHeldAndBlocked();
  });

  it('один trade-кандидат НЕ вызывает bind', async () => {
    await placeAmbiguous();
    const discovery = makeDiscovery(makeExchange([], [makeTradeSnapshot(VENUE_ID)]));

    const r = await discovery.execute({ accountId: ACCOUNT_ID });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.findings[0]).toMatchObject({ outcome: 'HEURISTIC_CANDIDATE_FOUND' });
      expect(r.value.findings[0].candidates[0]).toMatchObject({ kind: 'TRADE', venueOrderId: VENUE_ID });
    }
    await expectStillHeldAndBlocked();
  });

  it('старый UNKNOWN без кандидатов НЕ освобождает reservation (пустой venue-ответ — не доказательство)', async () => {
    await placeAmbiguous();
    nowMs += 24 * 60 * 60 * 1000; // сутки спустя — возраст НЕ разрешает release
    const discovery = makeDiscovery(makeExchange([], []));

    const r = await discovery.execute({ accountId: ACCOUNT_ID });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({ noCandidates: 1 });
      expect(r.value.findings[0].outcome).toBe('NO_CANDIDATE_INCONCLUSIVE');
    }
    await expectStillHeldAndBlocked();
  });

  it('venue API недоступен → VENUE_LOOKUP_INCOMPLETE, состояние не тронуто', async () => {
    await placeAmbiguous();
    const discovery = makeDiscovery(makeExchange([], [], { tradesOk: false }));

    const r = await discovery.execute({ accountId: ACCOUNT_ID });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.findings[0].outcome).toBe('VENUE_LOOKUP_INCOMPLETE');
    await expectStillHeldAndBlocked();
  });

  it('повторный discovery НЕ дублирует issue одного unresolved случая', async () => {
    await placeAmbiguous();
    const discovery = makeDiscovery(makeExchange([makeOpenOrderSnapshot(VENUE_ID)], []));

    await discovery.execute({ accountId: ACCOUNT_ID });
    await discovery.execute({ accountId: ACCOUNT_ID });
    await discovery.execute({ accountId: ACCOUNT_ID });

    const discoveryIssues = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
      .map((c) => c[0] as { id: string })
      .filter((i) => i.id.endsWith(':unknown-discovery'));
    // add вызывался трижды с ОДНИМ детерминированным id → в repo одна issue.
    expect(new Set(discoveryIssues.map((i) => i.id)).size).toBe(1);
    const open = await reconciliationIssues.listOpen();
    expect(open.filter((i) => (i as { id: string }).id.endsWith(':unknown-discovery'))).toHaveLength(1);
  });

  // ── Operator resolution ───────────────────────────────────────────────────

  it('ручной open-order bind: привязывает venueOrderId, но СОХРАНЯЕТ manual block (BOUND_AWAITING_ORDER_RECOVERY)', async () => {
    await placeAmbiguous();
    const resolver = makeResolver(makeExchange([makeOpenOrderSnapshot(VENUE_ID)], []));

    const r = await resolver.execute({
      clientOrderId: CLIENT_ID,
      accountId: ACCOUNT_ID,
      resolution: { type: 'BIND_VENUE_ORDER', venueOrderId: VENUE_ID, candidateKind: 'OPEN_ORDER', operatorId: 'ops-1', reason: 'verified in venue UI' },
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('BOUND_AWAITING_ORDER_RECOVERY');
    const record = await submissions.get(CLIENT_ID);
    expect(record?.status).toBe('VENUE_ACCEPTED');
    expect(String(record?.venueOrderId)).toBe(String(VENUE_ID));
    // Block ОСТАЁТСЯ: локальный Order ещё не восстановлен.
    expect(store.hasManualReconciliationBlockForOrder(CLIENT_ID)).toBe(true);
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
  });

  it('ручной trade bind: ставит matched/in-flight marker ДО снятия block; unsettled evidence сохраняется до применения Fill', async () => {
    await placeAmbiguous();
    const resolver = makeResolver(makeExchange([], [makeTradeSnapshot(VENUE_ID)]));

    const r = await resolver.execute({
      clientOrderId: CLIENT_ID,
      accountId: ACCOUNT_ID,
      resolution: { type: 'BIND_VENUE_ORDER', venueOrderId: VENUE_ID, candidateKind: 'TRADE', operatorId: 'ops-1', reason: 'single trade verified' },
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('BOUND_AWAITING_FILL');
    const record = await submissions.get(CLIENT_ID);
    expect(String(record?.venueOrderId)).toBe(String(VENUE_ID));
    // Block снят, но matched/in-flight markers держат hasUnsettledFills=true.
    expect(store.hasManualReconciliationBlockForOrder(CLIENT_ID)).toBe(false);
    expect(store.hasMatchedFills(VENUE_ID)).toBe(true);
    expect(store.hasUnsettledFills(INSTRUMENT_ID)).toBe(true);

    // Fill (тот же fillId, что у trade) применяется held-reservation path.
    const fillResult = await makeProcessFill().execute(makeFill(String(TRADE_FILL_ID)));
    expect(fillResult.ok).toBe(true);
    expect(portfolio.applyDebit).toHaveBeenCalledTimes(1); // consume reserved
    expect(portfolio.applyDirectDebit).not.toHaveBeenCalled();
    // Marker снят ПОСЛЕ успешного применения Fill.
    expect(store.hasMatchedFills(VENUE_ID)).toBe(false);
    const after = await submissions.get(CLIENT_ID);
    expect(after?.reservation).toMatchObject({ status: 'PARTIALLY_SETTLED', consumed: '32.5', remaining: '32.5' });
  });

  it('explicit CONFIRM_NOT_SUBMITTED освобождает reservation РОВНО один раз (повтор — Err)', async () => {
    await placeAmbiguous();
    const resolver = makeResolver(makeExchange([], []));

    const first = await resolver.execute({
      clientOrderId: CLIENT_ID,
      accountId: ACCOUNT_ID,
      resolution: { type: 'CONFIRM_NOT_SUBMITTED', operatorId: 'ops-1', reason: 'venue support confirmed no order' },
    });

    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.status).toBe('RELEASED_NOT_SUBMITTED');
    expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
    const record = await submissions.get(CLIENT_ID);
    expect(record?.status).toBe('FAILED');
    expect(record?.reason).toContain('OPERATOR_CONFIRMED_NOT_SUBMITTED by ops-1');
    expect(record?.reservation).toMatchObject({ status: 'SETTLED', remaining: '0', released: '65' });
    expect(store.hasManualReconciliationBlockForOrder(CLIENT_ID)).toBe(false);

    // Повторная резолюция — Err (статус уже не UNKNOWN), release НЕ повторяется.
    const second = await resolver.execute({
      clientOrderId: CLIENT_ID,
      accountId: ACCOUNT_ID,
      resolution: { type: 'CONFIRM_NOT_SUBMITTED', operatorId: 'ops-1', reason: 'repeat' },
    });
    expect(second.ok).toBe(false);
    expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
  });

  it('CONFIRM_NOT_SUBMITTED: journal failure после Portfolio release оставляет manual block (RECONCILIATION_REQUIRED)', async () => {
    await placeAmbiguous();
    // Journal падает на release (но не на пометке RECONCILIATION_REQUIRED).
    const realApply = submissions.applyReservationTransition.bind(submissions);
    jest.spyOn(submissions, 'applyReservationTransition').mockImplementation(async (id, transition) => {
      if (transition.release !== undefined) {
        return Err(new ReservationTransitionError('INVARIANT_VIOLATION', 'journal store down'));
      }
      return realApply(id, transition);
    });
    const resolver = makeResolver(makeExchange([], []));

    const r = await resolver.execute({
      clientOrderId: CLIENT_ID,
      accountId: ACCOUNT_ID,
      resolution: { type: 'CONFIRM_NOT_SUBMITTED', operatorId: 'ops-1', reason: 'confirmed absent' },
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('RECONCILIATION_REQUIRED');
    expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1); // Portfolio уже изменён
    // Block ОСТАЁТСЯ, journal → RECONCILIATION_REQUIRED, retry НЕ разрешён.
    expect(store.hasManualReconciliationBlockForOrder(CLIENT_ID)).toBe(true);
    const record = await submissions.get(CLIENT_ID);
    expect(record?.status).toBe('UNKNOWN'); // НЕ FAILED — retry запрещён
    expect(record?.reservation.status).toBe('RECONCILIATION_REQUIRED');
  });

  it('bind отклоняется при несовпадении экономических параметров кандидата', async () => {
    await placeAmbiguous();
    const wrongPrice = makeOpenOrderSnapshot(VENUE_ID, { price: Price.of(new Decimal('0.99')) });
    const resolver = makeResolver(makeExchange([wrongPrice], []));

    const r = await resolver.execute({
      clientOrderId: CLIENT_ID,
      accountId: ACCOUNT_ID,
      resolution: { type: 'BIND_VENUE_ORDER', venueOrderId: VENUE_ID, candidateKind: 'OPEN_ORDER', operatorId: 'ops-1', reason: 'oops' },
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/does not match/i);
    await expectStillHeldAndBlocked();
  });

  // ── Сквозной сценарий: deferred fill до резолюции, held path после ────────

  it('venue Fill до резолюции откладывается БЕЗ мутаций; после trade bind тот же fill применяется через held path', async () => {
    await placeAmbiguous();

    // Fill приходит ДО резолюции: deferred (manual block), никаких мутаций.
    const blocked = await makeProcessFill().execute(makeFill(String(TRADE_FILL_ID)));
    expect(blocked.ok).toBe(false);
    expect(portfolio.applyDebit).not.toHaveBeenCalled();
    expect(portfolio.applyDirectDebit).not.toHaveBeenCalled();
    expect(ledgerSpy).not.toHaveBeenCalled();

    // Оператор bind-ит trade → block снят, markers стоят.
    const resolver = makeResolver(makeExchange([], [makeTradeSnapshot(VENUE_ID)]));
    const resolved = await resolver.execute({
      clientOrderId: CLIENT_ID,
      accountId: ACCOUNT_ID,
      resolution: { type: 'BIND_VENUE_ORDER', venueOrderId: VENUE_ID, candidateKind: 'TRADE', operatorId: 'ops-1', reason: 'verified' },
    });
    expect(resolved.ok).toBe(true);

    // Retry того же fill (deferred → FAILED → retryable) — held path.
    const retried = await makeProcessFill().execute(makeFill(String(TRADE_FILL_ID)));
    expect(retried.ok).toBe(true);
    expect(portfolio.applyDebit).toHaveBeenCalledTimes(1);
    expect(portfolio.applyDirectDebit).not.toHaveBeenCalled();
  });
});
