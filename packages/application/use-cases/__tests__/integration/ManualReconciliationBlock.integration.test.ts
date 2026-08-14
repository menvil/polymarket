/**
 * Cross-use-case тесты manual reconciliation block (P0).
 *
 * @remarks
 * Сценарий-цель: journal release упал ПОСЛЕ успешного Portfolio release (или
 * journal consume упал после business commit fill) — journal остаётся HELD
 * (даже best-effort пометка RECONCILIATION_REQUIRED может упасть), и без
 * typed manual block задержанный/другой Fill выбрал бы held-reservation path
 * и потребил бы общий reserved-капитал аккаунта (для BUY USDC-резервация
 * агрегирована на аккаунте, не на ордере).
 *
 * Проверяем сквозь границы use-case'ов (общий IOrderStateStore + journal):
 * 1. Cancel journal failure → другой Fill блокируется БЕЗ мутаций.
 * 2. Update journal failure → Fill блокируется БЕЗ мутаций.
 * 3. Fill A journal failure → другой fillId B блокируется БЕЗ мутаций.
 * Во всех случаях manual block ОСТАЁТСЯ после прихода fill (fill его не снимает).
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { unsafeRunId } from '@polymarket/ids';
import Decimal from 'decimal.js';
import { Ok, Err } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type {
  IExchangeClient,
  IKeyedMutex,
  IPortfolioStore,
  IProcessedFillRepository,
  IOrderedEventOutbox,
  OrderSubmissionRecord,
} from '@polymarket/ports';
import { ReservationTransitionError } from '@polymarket/ports';
import type { AccountId, AssetId, FillId, InstrumentId, OrderId } from '@polymarket/ids';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { Fill } from '@polymarket/fill';
import { Order } from '@polymarket/order';
import { Price, Quantity } from '@polymarket/value-objects';
import { CancelOrderUseCase } from '../../src/CancelOrderUseCase.js';
import { UpdateOrderStatusUseCase } from '../../src/UpdateOrderStatusUseCase.js';
import { ProcessFillUseCase } from '../../src/ProcessFillUseCase.js';
import { PortfolioService } from '../../src/services/PortfolioService.js';
import { LedgerService } from '../../src/services/LedgerService.js';
import { InMemoryOrderRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderRepository.js';
import { InMemoryOrderSubmissionRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderSubmissionRepository.js';
import { InMemoryOrderedEventOutbox } from '../../../../infrastructure/in-memory/src/InMemoryOrderedEventOutbox.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;
const ASSET_ID = { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'token-abc' } as unknown as AssetId;
const INSTRUMENT_ID = 'token-abc' as unknown as InstrumentId;
const ORDER_ID = 'order-1' as unknown as OrderId;
const CLIENT_ID = 'client-1' as unknown as OrderId;

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

function makeOutbox(bus: IEventBus): IOrderedEventOutbox {
  return new InMemoryOrderedEventOutbox({
    publish: async (events) => {
      const result = await bus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);
      if (!result.ok) throw result.error;
    },
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

function makeProcessedFillRepo(): IProcessedFillRepository {
  return {
    begin: jest.fn<IProcessedFillRepository['begin']>().mockResolvedValue({ outcome: 'ACQUIRED', isRetry: false }),
    markApplied: jest.fn<IProcessedFillRepository['markApplied']>().mockResolvedValue(undefined),
    markFailed: jest.fn<IProcessedFillRepository['markFailed']>().mockResolvedValue(undefined),
    markReverted: jest.fn<IProcessedFillRepository['markReverted']>().mockResolvedValue(undefined),
    markReconciliationRequired: jest.fn<IProcessedFillRepository['markReconciliationRequired']>().mockResolvedValue(undefined),
    getStatus: jest.fn<IProcessedFillRepository['getStatus']>().mockResolvedValue(undefined),
  };
}

/**
 * Реалистичный (stateful) idempotency-репозиторий: FAILED → retry разрешён
 * (ACQUIRED c isRetry), APPLIED → DUPLICATE, RECONCILIATION_REQUIRED → терминал.
 */
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

function makeOpenOrder(orderId: OrderId = ORDER_ID): Order {
  const result = Order.create({
    id: orderId,
    asset: ASSET_ID,
    side: 'BUY',
    price: Price.of(new Decimal('0.65')) as never,
    size: Quantity.of(new Decimal('100')) as never,
    timestamp: { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '2024-01-01T00:00:00.000Z' } as never,
  });
  if (!result.ok) throw new Error('Failed to create Order');
  const accepted = result.value.accept();
  if (!accepted.ok) throw new Error('Failed to accept Order');
  accepted.value.pullEvents(() => makeMetadataGenerator().nextRoot());
  return accepted.value;
}

function makeFill(id: string, size = '50', orderId: OrderId = ORDER_ID): Fill {
  return {
    id: id as unknown as FillId,
    orderId,
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

/**
 * Wrapper над реальным journal-репозиторием, роняющий ВСЕ
 * applyReservationTransition (включая best-effort пометку
 * RECONCILIATION_REQUIRED) — worst case: journal остаётся HELD, единственная
 * защита — manual block.
 */
function makeFailingJournal(real: InMemoryOrderSubmissionRepository): InMemoryOrderSubmissionRepository {
  const failing = Object.create(real) as InMemoryOrderSubmissionRepository;
  failing.applyReservationTransition = async (): Promise<Result<OrderSubmissionRecord, ReservationTransitionError>> =>
    Err(new ReservationTransitionError('INVARIANT_VIOLATION', 'journal store down'));
  return failing;
}

/** Seed журнала: held BUY-резервация 65 USDC под venueOrderId=ORDER_ID. */
async function seedHeldJournal(submissions: InMemoryOrderSubmissionRepository): Promise<void> {
  await submissions.begin({
    clientOrderId: CLIENT_ID,
    accountId: ACCOUNT_ID,
    instrumentId: INSTRUMENT_ID,
    fingerprint: 'fp',
    side: 'BUY',
    orderPrice: '0.65',
    requestedSize: '100',
    now: new Date(),
  });
  await submissions.markReservationHeld(CLIENT_ID, '65', new Date());
  await submissions.markCommitted(CLIENT_ID, ORDER_ID, new Date());
}

// ── Tests ─────────────────────────────────────────────────────────────────────


/** Детерминированный canonical-генератор metadata для тестовых deps (M-003). */
function makeMetadataGenerator(): MessageMetadataGenerator {
  return new MessageMetadataGenerator({
    clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
    runId: unsafeRunId('testrun1'),
  });
}

describe('Manual reconciliation block — cross-use-case (P0)', () => {
  let logger: ILogger;
  let eventBus: IEventBus;
  let store: InMemoryOrderRepository;
  let realJournal: InMemoryOrderSubmissionRepository;
  let failingJournal: InMemoryOrderSubmissionRepository;
  let portfolio: Portfolio;
  let portfolioService: PortfolioService;
  let ledgerService: LedgerService;
  let ledgerSpy: ReturnType<typeof jest.spyOn>;
  let processedFillRepo: IProcessedFillRepository;

  beforeEach(async () => {
    logger = makeLogger();
    eventBus = makeEventBus();
    store = new InMemoryOrderRepository();
    realJournal = new InMemoryOrderSubmissionRepository();
    failingJournal = makeFailingJournal(realJournal);
    portfolio = makePortfolioMock();
    portfolioService = new PortfolioService(makePortfolioStore(portfolio), logger);
    ledgerService = new LedgerService(makeLogger());
    ledgerSpy = jest.spyOn(ledgerService as unknown as { recordFill: (f: Fill) => void }, 'recordFill')
      .mockReturnValue(undefined);
    processedFillRepo = makeProcessedFillRepo();

    await seedHeldJournal(realJournal);
    const saveResult = await store.save(makeOpenOrder(), 0);
    if (!saveResult.ok) throw new Error('seed order save failed');
  });

  function makeProcessFill(): ProcessFillUseCase {
    return new ProcessFillUseCase({
      metadataGenerator: makeMetadataGenerator(),
      orderStateStore: store,
      portfolioService,
      ledgerService,
      orderRepo: store,
      processedFillRepo,
      keyedMutex: makeKeyedMutex(),
      eventBus,
      orderedEventOutbox: makeOutbox(eventBus),
      submissions: failingJournal,
      logger,
    });
  }

  /** Общие проверки: fill заблокирован, мутаций нет, block пережил fill. */
  async function expectFillBlockedWithoutMutations(fillId: string): Promise<void> {
    const result = await makeProcessFill().execute(makeFill(fillId));
    expect(result.ok).toBe(false);

    // Portfolio НЕ мутирован этим fill-ом (held path не выполнялся).
    expect(portfolio.applyDebit).not.toHaveBeenCalled();
    expect(portfolio.applyDirectDebit).not.toHaveBeenCalled();
    expect(portfolio.applyCredit).not.toHaveBeenCalled();
    // Ledger НЕ записан.
    expect(ledgerSpy).not.toHaveBeenCalled();
    // Journal amounts не тронуты (остался HELD — worst case).
    const record = await realJournal.get(CLIENT_ID);
    expect(record?.reservation).toMatchObject({ remaining: '65', consumed: '0', status: 'HELD' });
    // Fill НЕ снял manual block (в отличие от MATCHED placeholder).
    expect(store.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(true);
    expect(store.hasUnsettledFills(INSTRUMENT_ID)).toBe(true);
    // Fill отложен как retryable (deferred, P1): НЕ APPLIED и НЕ terminal —
    // после ручного clearManualReconciliationBlock его можно повторить.
    expect(processedFillRepo.markFailed).toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining('MANUAL_RECONCILIATION_BLOCK_DEFERRED'),
    );
    expect(processedFillRepo.markApplied).not.toHaveBeenCalled();
  }

  it('cancel journal failure → задержанный Fill блокируется, Portfolio/Ledger не мутируются, block остаётся', async () => {
    const exchangeClient: IExchangeClient = {
      submitOrder: jest.fn<IExchangeClient['submitOrder']>(),
      cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
      getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
      getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
    };
    const cancelUseCase = new CancelOrderUseCase({
      metadataGenerator: makeMetadataGenerator(),
      portfolioService,
      orderRepo: store,
      orderStateStore: store,
      keyedMutex: makeKeyedMutex(),
      exchangeClient,
      orderedEventOutbox: makeOutbox(eventBus),
      submissions: failingJournal,
      logger,
    });

    // 1-4: venue подтвердил cancel, local CANCELED, Portfolio released, journal упал.
    const cancelResult = await cancelUseCase.execute({ orderId: ORDER_ID, accountId: ACCOUNT_ID });
    expect(cancelResult.ok).toBe(true);
    if (cancelResult.ok) expect(cancelResult.value.status).toBe('RECONCILIATION_REQUIRED');
    expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
    expect(store.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(true);
    // Journal остался HELD (worst case: и release, и best-effort пометка упали).
    const record = await realJournal.get(CLIENT_ID);
    expect(record?.reservation.status).toBe('HELD');

    // 5-8: задержанный Fill НЕ проходит held path и НЕ снимает block.
    (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockClear();
    await expectFillBlockedWithoutMutations('late-fill-1');
  });

  it('update (deferred) → settle journal failure → escalated manual block → Fill блокируется без мутаций', async () => {
    const updateUseCase = new UpdateOrderStatusUseCase({
      metadataGenerator: makeMetadataGenerator(),
      orderRepo: store,
      orderStateStore: store,
      portfolioService,
      keyedMutex: makeKeyedMutex(),
      orderedEventOutbox: makeOutbox(eventBus),
      submissions: failingJournal,
      logger,
    });

    // Terminal update с held journal → settlement DEFERRED (pending), капитал held.
    const updateResult = await updateUseCase.execute({
      update: { type: 'CANCELLED', orderId: ORDER_ID },
      accountId: ACCOUNT_ID,
    });
    expect(updateResult.ok).toBe(true);
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);

    // Settle-резолвер: venue trades пусты (Ok), Portfolio release ok, journal
    // release падает (и best-effort пометка тоже) → escalated manual block.
    const { SettleTerminalOrdersUseCase } = await import('../../src/SettleTerminalOrdersUseCase.js');
    const settle = new SettleTerminalOrdersUseCase({
      orderStateStore: store,
      submissions: failingJournal,
      portfolioService,
      exchangeClient: {
        submitOrder: jest.fn(), cancelOrder: jest.fn(),
        getOpenOrders: jest.fn().mockImplementation(async () => Ok([])),
        getTrades: jest.fn().mockImplementation(async () => Ok([])),
      } as unknown as import('@polymarket/ports').IExchangeClient,
      processedFillRepo,
      fillProcessor: makeProcessFill(),
      tradeToFill: () => { throw new Error('not used'); },
      keyedMutex: makeKeyedMutex(),
      clock: { now: () => new Date() },
      logger,
      minSettleDelayMs: 0,
    });
    const settleResult = await settle.execute({ accountId: ACCOUNT_ID });
    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ escalated: 1, settled: 0 });
    expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1); // Portfolio уже освобождён
    expect(store.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(true);
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(false);

    (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockClear();
    await expectFillBlockedWithoutMutations('late-fill-2');
  });

  it('P1: fill B чужого Order отложен (deferred) блоком Order A, после clear блока retry применяет его РОВНО один раз', async () => {
    const ORDER_B = 'order-B' as unknown as OrderId;
    // Order B — живой локальный ордер того же инструмента (normal path).
    const saveB = await store.save(makeOpenOrder(ORDER_B), 0);
    if (!saveB.ok) throw new Error('seed order B save failed');
    // 1. Order A ставит manual block на инструмент.
    store.markManualReconciliationBlock({ orderId: ORDER_ID, instrumentId: INSTRUMENT_ID, reason: 'order A desync' });

    const statefulRepo = makeStatefulProcessedFillRepo();
    const useCase = new ProcessFillUseCase({
      metadataGenerator: makeMetadataGenerator(),
      orderStateStore: store,
      portfolioService,
      ledgerService,
      orderRepo: store,
      processedFillRepo: statefulRepo,
      keyedMutex: makeKeyedMutex(),
      eventBus,
      orderedEventOutbox: makeOutbox(eventBus),
      submissions: realJournal,
      logger,
    });
    const fillB = makeFill('fill-B', '50', ORDER_B);

    // 2-3. Fill B блокируется ДО мутаций, но НЕ терминально (deferred).
    const first = await useCase.execute(fillB);
    expect(first.ok).toBe(false);
    expect(portfolio.applyDebit).not.toHaveBeenCalled();
    expect(portfolio.applyDirectDebit).not.toHaveBeenCalled();
    expect(ledgerSpy).not.toHaveBeenCalled();
    expect(statefulRepo.markReconciliationRequired).not.toHaveBeenCalled();

    // Retry при ЖИВОМ блоке — снова deferred, мутаций по-прежнему нет.
    const retryWhileBlocked = await useCase.execute(fillB);
    expect(retryWhileBlocked.ok).toBe(false);
    expect(portfolio.applyDebit).not.toHaveBeenCalled();

    // 4. Оператор снимает блок Order A.
    store.clearManualReconciliationBlock(ORDER_ID);

    // 5-6. Повторный execute применяет fill B РОВНО один раз.
    const second = await useCase.execute(fillB);
    expect(second.ok).toBe(true);
    expect(portfolio.applyDebit).toHaveBeenCalledTimes(1);
    expect(ledgerSpy).toHaveBeenCalledTimes(1);
    expect(statefulRepo.markApplied).toHaveBeenCalledTimes(1);

    // Третий вызов — DUPLICATE no-op (не двойное применение).
    const third = await useCase.execute(fillB);
    expect(third.ok).toBe(true);
    expect(portfolio.applyDebit).toHaveBeenCalledTimes(1);
  });

  it('placeholder e2e: Cancel ALREADY_FILLED ставит placeholder → реальный Fill снимает его ЯВНО (hasMatchedFills=false)', async () => {
    // Cancel получает ALREADY_FILLED → placeholder на order+instrument.
    const exchangeClient: IExchangeClient = {
      submitOrder: jest.fn<IExchangeClient['submitOrder']>(),
      cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(
        Ok({ status: 'ALREADY_FILLED', reason: 'matched' }),
      ),
      getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
      getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
    };
    const cancelUseCase = new CancelOrderUseCase({
      metadataGenerator: makeMetadataGenerator(),
      portfolioService,
      orderRepo: store,
      orderStateStore: store,
      keyedMutex: makeKeyedMutex(),
      exchangeClient,
      orderedEventOutbox: makeOutbox(eventBus),
      submissions: realJournal,
      logger,
    });
    const cancelResult = await cancelUseCase.execute({ orderId: ORDER_ID, accountId: ACCOUNT_ID });
    expect(cancelResult.ok).toBe(true);
    if (cancelResult.ok) expect(cancelResult.value.status).toBe('FILL_PENDING');
    expect(store.hasMatchedFills(ORDER_ID)).toBe(true);
    expect(store.hasUnsettledFills(INSTRUMENT_ID)).toBe(true);

    // Реальный Fill (нормальный path, живой Order) снимает placeholder ЯВНО
    // (контракт store — exact-ID): hasMatchedFills больше не залипает.
    const fillProcessor = new ProcessFillUseCase({
      metadataGenerator: makeMetadataGenerator(),
      orderStateStore: store,
      portfolioService,
      ledgerService,
      orderRepo: store,
      processedFillRepo,
      keyedMutex: makeKeyedMutex(),
      eventBus,
      orderedEventOutbox: makeOutbox(eventBus),
      submissions: realJournal,
      logger,
    });
    const fillResult = await fillProcessor.execute(makeFill('real-fill-1'));
    expect(fillResult.ok).toBe(true);
    expect(store.hasMatchedFills(ORDER_ID)).toBe(false);
  });

  it('fill A journal failure → другой fillId B блокируется, Portfolio/Ledger не мутируются повторно, block остаётся', async () => {
    // Fill A: business commit (Order+Portfolio+Ledger) → journal consume упал →
    // RECONCILIATION_REQUIRED + manual block.
    const fillA = await makeProcessFill().execute(makeFill('fill-A'));
    expect(fillA.ok).toBe(false);
    expect(portfolio.applyDebit).toHaveBeenCalledTimes(1);
    expect(ledgerSpy).toHaveBeenCalledTimes(1);
    expect(store.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(true);

    // Fill B (другой fillId, idempotency guard его НЕ знает — ACQUIRED):
    // блокируется manual block guard'ом ДО мутаций.
    const fillB = await makeProcessFill().execute(makeFill('fill-B'));
    expect(fillB.ok).toBe(false);
    // Мутации НЕ повторились: applyDebit/Ledger всё ещё ровно 1 (от fill A).
    expect(portfolio.applyDebit).toHaveBeenCalledTimes(1);
    expect(ledgerSpy).toHaveBeenCalledTimes(1);
    expect(store.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(true);
    expect(processedFillRepo.markApplied).not.toHaveBeenCalled();
  });
});
