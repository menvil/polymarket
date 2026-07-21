import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ProcessFillUseCase } from '../src/ProcessFillUseCase.js';
import { PortfolioService } from '../src/services/PortfolioService.js';
import { LedgerService } from '../src/services/LedgerService.js';
import type { ProcessFillDeps } from '../src/ProcessFillUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type {
  IOrderRepository,
  IPortfolioStore,
  IProcessedFillRepository,
  IOrderStateStore,
  IKeyedMutex,
  InFlightFill,
  BeginFillProcessingResult,
  IReconciliationIssueRepository,
  IOrderedEventOutbox,
} from '@polymarket/ports';
import { pendingMatchFillId } from '@polymarket/ports';
import { InMemoryOrderedEventOutbox } from '../../../infrastructure/in-memory/src/InMemoryOrderedEventOutbox.js';
import { InMemoryOrderSubmissionRepository } from '../../../infrastructure/in-memory/src/InMemoryOrderSubmissionRepository.js';
import { InMemoryKeyedMutex } from '../../../infrastructure/in-memory/src/InMemoryKeyedMutex.js';
import { InMemoryProcessedFillRepository } from '../../../infrastructure/in-memory/src/InMemoryProcessedFillRepository.js';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { AccountId, AssetId, FillId, InstrumentId, OrderId, VenueId, MarketId } from '@polymarket/ids';
import type { Fill, FillParams } from '@polymarket/fill';
import { Price, Quantity } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import { Order } from '@polymarket/order';
import Decimal from 'decimal.js';

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
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
    subscribe: jest.fn<IEventBus['subscribe']>().mockReturnValue(() => {}),
  };
}

/**
 * Реальный ordered outbox, публикующий в переданный eventBus на flush().
 *
 * @remarks
 * Использует реальный `InMemoryOrderedEventOutbox`: `flush()` НИКОГДА не бросает
 * (ошибки публикации проглатываются с EVENT_PUBLISH_FAILED). Нормальный путь
 * ProcessFillUseCase публикует через outbox, поэтому assertion'ы на
 * `eventBus.publishAll` продолжают работать (flush → publishAll).
 */
function makeOutbox(
  eventBus: IEventBus,
  reconciliationIssues?: IReconciliationIssueRepository,
): IOrderedEventOutbox {
  return new InMemoryOrderedEventOutbox({
    publish: (events) => eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]),
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
// AssetId как структурный объект для корректной работы assetIdToString
const ASSET_ID = { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'token-abc' } as unknown as AssetId;
const ORDER_ID = 'order-1' as unknown as OrderId;
const FILL_ID = 'fill-1' as unknown as FillId;
const VENUE_ID = 'POLYMARKET' as unknown as VenueId;
const MARKET_ID = 'market-1' as unknown as MarketId;

/** Создаёт мок Fill для тестов */
function makeFill(overrides: Partial<FillParams> = {}): Fill {
  return {
    id: FILL_ID,
    orderId: ORDER_ID,
    accountId: ACCOUNT_ID,
    venueId: VENUE_ID,
    marketId: MARKET_ID,
    tokenId: ASSET_ID,
    settlementAssetId: 'USDC' as unknown as AssetId,
    price: makePrice('0.65'),
    size: makeQty('50'),
    side: 'BUY',
    timestamp: { value: () => new Decimal(1000), toNumber: () => 1000 } as never,
    fee: { amount: { value: () => new Decimal(0) }, asset: 'USDC' as unknown as AssetId, isZero: () => true } as never,
    hasFee: () => false,
    getSignedQuantity: () => ({ asset: ASSET_ID, amount: new Decimal('50') }),
    getCashFlow: () => ({ asset: 'USDC' as unknown as AssetId, amount: new Decimal('-32.5') }),
    getFeeFlow: () => ({ asset: 'USDC' as unknown as AssetId, amount: new Decimal(0) }),
    getNetCashFlow: () => ({ asset: 'USDC' as unknown as AssetId, amount: new Decimal('-32.5') }),
    getNotional: () => ({ asset: 'USDC' as unknown as AssetId, amount: new Decimal('32.5') }),
    ...overrides,
  } as unknown as Fill;
}

function makeOrderOpen(): Order {
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
  accepted.value.pullEvents(); // clear events
  return accepted.value;
}

function makePortfolioMock(): Portfolio {
  const p: Portfolio = {
    accountId: ACCOUNT_ID,
    balance: {
      available: () => ({ value: () => new Decimal('10000') }),
      reserved: () => ({ value: () => new Decimal(0) }),
      total: () => ({ value: () => new Decimal('10000') }),
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
    applyDirectDebit: jest.fn<Portfolio['applyDirectDebit']>(),
    upsertPosition: jest.fn<Portfolio['upsertPosition']>(),
    tokenReservations: new Map(),
  } as unknown as Portfolio;

  // mock вернёт сам себя при applyDebit (side effect: позиция обновилась)
  (p.applyDebit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.applyCredit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.applyDirectDebit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.upsertPosition as ReturnType<typeof jest.fn>).mockReturnValue(p);
  (p.reserveForOrder as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.reserveTokensForOrder as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
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

function makeOrderStateStore(order?: Order): IOrderStateStore {
  return {
    getOrder: jest.fn<IOrderStateStore['getOrder']>().mockReturnValue(order),
    saveSync: jest.fn<IOrderStateStore['saveSync']>(),
    getOpenOrders: jest.fn<IOrderStateStore['getOpenOrders']>().mockReturnValue([]),
    getOpenOrdersByInstrument: jest.fn<IOrderStateStore['getOpenOrdersByInstrument']>().mockReturnValue([]),
    markOrderFillMatched: jest.fn<IOrderStateStore['markOrderFillMatched']>(),
    clearOrderFillMatched: jest.fn<IOrderStateStore['clearOrderFillMatched']>(),
    hasMatchedFills: jest.fn<IOrderStateStore['hasMatchedFills']>().mockReturnValue(false),
    getMatchedFillIds: jest.fn<IOrderStateStore['getMatchedFillIds']>().mockReturnValue([]),
    markInFlightFill: jest.fn<IOrderStateStore['markInFlightFill']>(),
    updateInFlightFillStatus: jest.fn<IOrderStateStore['updateInFlightFillStatus']>(),
    clearInFlightFill: jest.fn<IOrderStateStore['clearInFlightFill']>(),
    hasInFlightFills: jest.fn<IOrderStateStore['hasInFlightFills']>().mockReturnValue(false),
    getInFlightFills: jest.fn<IOrderStateStore['getInFlightFills']>().mockReturnValue([] as readonly InFlightFill[]),
    markFillProcessing: jest.fn<IOrderStateStore['markFillProcessing']>(),
    updateFillProcessingStatus: jest.fn<IOrderStateStore['updateFillProcessingStatus']>(),
    clearFillProcessing: jest.fn<IOrderStateStore['clearFillProcessing']>(),
    hasFillProcessingBlocks: jest.fn<IOrderStateStore['hasFillProcessingBlocks']>().mockReturnValue(false),
    getFillProcessingBlocks: jest.fn<IOrderStateStore['getFillProcessingBlocks']>().mockReturnValue([]),
    hasUnsettledFills: jest.fn<IOrderStateStore['hasUnsettledFills']>().mockReturnValue(false),
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

function makeProcessedFillRepo(
  beginResult: BeginFillProcessingResult = { outcome: 'ACQUIRED', isRetry: false },
): IProcessedFillRepository {
  return {
    begin: jest.fn<IProcessedFillRepository['begin']>().mockResolvedValue(beginResult),
    markApplied: jest.fn<IProcessedFillRepository['markApplied']>().mockResolvedValue(undefined),
    markFailed: jest.fn<IProcessedFillRepository['markFailed']>().mockResolvedValue(undefined),
    markReverted: jest.fn<IProcessedFillRepository['markReverted']>().mockResolvedValue(undefined),
    markReconciliationRequired: jest.fn<IProcessedFillRepository['markReconciliationRequired']>().mockResolvedValue(undefined),
    getStatus: jest.fn<IProcessedFillRepository['getStatus']>().mockResolvedValue(undefined),
  };
}

function makeKeyedMutex(): IKeyedMutex {
  return {
    runExclusive: jest.fn(<T>(_keys: readonly string[], fn: () => Promise<T>) => fn()) as unknown as IKeyedMutex['runExclusive'],
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ProcessFillUseCase', () => {
  let logger: ILogger;
  let eventBus: IEventBus;
  let orderRepo: IOrderRepository;
  let orderStateStore: IOrderStateStore;
  let portfolioStore: IPortfolioStore;
  let processedFillRepo: IProcessedFillRepository;
  let keyedMutex: IKeyedMutex;
  let deps: ProcessFillDeps;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    const order = makeOrderOpen();
    orderRepo = makeOrderRepo(order);
    orderStateStore = makeOrderStateStore(order);
    portfolioStore = makePortfolioStore();
    processedFillRepo = makeProcessedFillRepo();
    keyedMutex = makeKeyedMutex();

    const portfolioService = new PortfolioService(portfolioStore, logger);
    const ledgerService = new LedgerService(logger);

    deps = {
      orderStateStore,
      portfolioService,
      ledgerService,
      orderRepo,
      processedFillRepo,
      keyedMutex,
      eventBus,
      orderedEventOutbox: makeOutbox(eventBus),
      // Пустой submission journal: findByVenueOrderId→undefined → normal/direct
      // path (held-recovery проверяется отдельными тестами с seeded journal).
      submissions: new InMemoryOrderSubmissionRepository(),
      logger,
    };
  });

  // ── Успешный сценарий ─────────────────────────────────────────────────────

  it('возвращает Ok(void) при успешной обработке fill', async () => {
    const useCase = new ProcessFillUseCase(deps);
    const result = await useCase.execute(makeFill());
    expect(result.ok).toBe(true);
  });

  it('обновляет ордер в хранилище (saveSync)', async () => {
    const useCase = new ProcessFillUseCase(deps);
    await useCase.execute(makeFill());
    expect(orderStateStore.saveSync).toHaveBeenCalled();
  });

  it('публикует события', async () => {
    const useCase = new ProcessFillUseCase(deps);
    await useCase.execute(makeFill());
    expect(eventBus.publishAll).toHaveBeenCalled();
  });

  it('логирует info при успешной обработке', async () => {
    const useCase = new ProcessFillUseCase(deps);
    await useCase.execute(makeFill());
    expect(logger.info).toHaveBeenCalledWith('Fill processed successfully', expect.any(Object));
  });

  it('снимает matched-флаг конкретного fill после обработки', async () => {
    const useCase = new ProcessFillUseCase(deps);
    await useCase.execute(makeFill());
    expect(orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith(ORDER_ID, FILL_ID);
  });

  it('снимает in-flight флаги: реальный fillId И pending placeholder этого ордера', async () => {
    const useCase = new ProcessFillUseCase(deps);
    await useCase.execute(makeFill());
    // Реальный fill «разрешает» более раннюю неоднозначную пометку от
    // cancel ALREADY_FILLED / submit FILLED (placeholder pendingMatchFillId).
    expect(orderStateStore.clearInFlightFill).toHaveBeenCalledWith(FILL_ID);
    expect(orderStateStore.clearInFlightFill).toHaveBeenCalledWith(pendingMatchFillId(ORDER_ID));
  });

  it('помечает fill как APPLIED после успешной обработки', async () => {
    const useCase = new ProcessFillUseCase(deps);
    await useCase.execute(makeFill());
    expect(processedFillRepo.markApplied).toHaveBeenCalledWith(FILL_ID);
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it('возвращает Ok(void) при дублирующемся (APPLIED) fill — DUPLICATE', async () => {
    processedFillRepo = makeProcessedFillRepo({ outcome: 'DUPLICATE' });
    const useCase = new ProcessFillUseCase({ ...deps, processedFillRepo });
    const result = await useCase.execute(makeFill());
    expect(result.ok).toBe(true);
  });

  it('не обновляет ордер при DUPLICATE fill', async () => {
    processedFillRepo = makeProcessedFillRepo({ outcome: 'DUPLICATE' });
    const useCase = new ProcessFillUseCase({ ...deps, processedFillRepo });
    await useCase.execute(makeFill());
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  it('возвращает Ok(void) и не обрабатывает fill при BUSY (конкурентная обработка)', async () => {
    processedFillRepo = makeProcessedFillRepo({ outcome: 'BUSY' });
    const useCase = new ProcessFillUseCase({ ...deps, processedFillRepo });
    const result = await useCase.execute(makeFill());
    expect(result.ok).toBe(true);
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  it('логирует retry при ACQUIRED с isRetry=true (после предыдущего FAILED)', async () => {
    processedFillRepo = makeProcessedFillRepo({ outcome: 'ACQUIRED', isRetry: true });
    const useCase = new ProcessFillUseCase({ ...deps, processedFillRepo });
    await useCase.execute(makeFill());
    expect(logger.info).toHaveBeenCalledWith(
      'Retrying previously failed/reverted fill',
      expect.objectContaining({ fillId: String(FILL_ID) }),
    );
  });

  it('помечает fill как FAILED, если order.applyFill возвращает Err (retry разрешён)', async () => {
    // order.size=100, fill.size=150 → applyFill отклонит (превышает remainingSize)
    const order = makeOrderOpen();
    orderRepo = makeOrderRepo(order);
    orderStateStore = makeOrderStateStore(order);
    processedFillRepo = makeProcessedFillRepo();
    const useCase = new ProcessFillUseCase({ ...deps, orderRepo, orderStateStore, processedFillRepo });

    const oversizedFill = makeFill({ size: makeQty('150') } as never);
    const result = await useCase.execute(oversizedFill);

    expect(result.ok).toBe(false);
    expect(processedFillRepo.markFailed).toHaveBeenCalledWith(FILL_ID, expect.any(String));
    expect(processedFillRepo.markApplied).not.toHaveBeenCalled();
    // Flags тоже снимаются на error path — fill уже on-chain, не должен оставлять stuck state
    expect(orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith(ORDER_ID, FILL_ID);
    expect(orderStateStore.clearInFlightFill).toHaveBeenCalledWith(FILL_ID);
  });

  it('после FAILED повторный begin() с isRetry=true позволяет retry — fill обрабатывается заново', async () => {
    // Симулируем: первая попытка упала (FAILED), вторая (retry) должна пройти успешно.
    processedFillRepo = makeProcessedFillRepo({ outcome: 'ACQUIRED', isRetry: true });
    const useCase = new ProcessFillUseCase({ ...deps, processedFillRepo });

    const result = await useCase.execute(makeFill());

    expect(result.ok).toBe(true);
    expect(orderRepo.save).not.toHaveBeenCalled(); // saveSync используется, не async save
    expect(orderStateStore.saveSync).toHaveBeenCalled();
    expect(processedFillRepo.markApplied).toHaveBeenCalledWith(FILL_ID);
  });

  // ── Order не найден ───────────────────────────────────────────────────────

  it('возвращает Ok если ордер не найден (только ledger)', async () => {
    // Ордер не найден — fill записывается в ledger, portfolio корректируется reconciler'ом
    orderRepo = makeOrderRepo(undefined);
    const directOrderStateStore = makeOrderStateStore(undefined);
    const useCase = new ProcessFillUseCase({ ...deps, orderStateStore: directOrderStateStore, orderRepo });
    const result = await useCase.execute(makeFill());
    expect(result.ok).toBe(true);
  });

  it('снимает matched-флаг в direct fill path (ордер не найден)', async () => {
    orderRepo = makeOrderRepo(undefined);
    const directOrderStateStore = makeOrderStateStore(undefined);
    const useCase = new ProcessFillUseCase({ ...deps, orderStateStore: directOrderStateStore, orderRepo });
    await useCase.execute(makeFill());
    expect(directOrderStateStore.clearOrderFillMatched).toHaveBeenCalledWith(ORDER_ID, FILL_ID);
  });

  it('помечает fill как APPLIED в direct fill path (ордер не найден)', async () => {
    orderRepo = makeOrderRepo(undefined);
    const directOrderStateStore = makeOrderStateStore(undefined);
    const useCase = new ProcessFillUseCase({ ...deps, orderStateStore: directOrderStateStore, orderRepo });
    await useCase.execute(makeFill());
    expect(processedFillRepo.markApplied).toHaveBeenCalledWith(FILL_ID);
  });

  // ── Publish failure после commit (не должен делать fill retryable) ────────

  it('normal path: publishAll падает на flush после commit → Ok (fill APPLIED, не retryable), EVENT_PUBLISH_FAILED issue (создаёт outbox)', async () => {
    // Нормальный путь публикует через ordered outbox (flush после lock). Сбой
    // публикации проглатывается outbox'ом: он логирует EVENT_PUBLISH_FAILED и
    // создаёт issue, а ProcessFillUseCase возвращает Ok (fill уже APPLIED).
    const failingBus: IEventBus = {
      ...eventBus,
      publishAll: jest.fn<IEventBus['publishAll']>().mockRejectedValue(new Error('bus down')),
    };
    const reconciliationIssues = makeReconciliationIssueRepo();
    const useCase = new ProcessFillUseCase({
      ...deps,
      orderedEventOutbox: makeOutbox(failingBus, reconciliationIssues),
    });

    const result = await useCase.execute(makeFill());

    // Fill уже committed и APPLIED — потеря уведомления не делает операцию
    // retryable: Ok, не Err.
    expect(result.ok).toBe(true);
    expect(processedFillRepo.markApplied).toHaveBeenCalledWith(FILL_ID);
    expect(processedFillRepo.markFailed).not.toHaveBeenCalled();
    expect(failingBus.publishAll).toHaveBeenCalled();
    // Outbox создал EVENT_PUBLISH_FAILED issue (queryable, для ручного replay).
    const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
      .map((c) => c[0] as { type: string })
      .find((i) => i.type === 'EVENT_PUBLISH_FAILED');
    expect(issue).toBeDefined();
  });

  it('direct fill path: publishAll падает на flush после commit → Ok (fill APPLIED, не retryable), EVENT_PUBLISH_FAILED issue (создаёт outbox)', async () => {
    orderRepo = makeOrderRepo(undefined);
    const directOrderStateStore = makeOrderStateStore(undefined);
    // Direct-fill теперь публикует DIRECT_FILL_APPLIED через outbox (aggregateId=orderId).
    const failingBus: IEventBus = {
      ...eventBus,
      publishAll: jest.fn<IEventBus['publishAll']>().mockRejectedValue(new Error('bus down')),
    };
    const reconciliationIssues = makeReconciliationIssueRepo();
    const useCase = new ProcessFillUseCase({
      ...deps,
      orderStateStore: directOrderStateStore,
      orderRepo,
      orderedEventOutbox: makeOutbox(failingBus, reconciliationIssues),
    });

    const result = await useCase.execute(makeFill());

    expect(result.ok).toBe(true);
    expect(processedFillRepo.markApplied).toHaveBeenCalledWith(FILL_ID);
    expect(processedFillRepo.markFailed).not.toHaveBeenCalled();
    // Сбой публикации проглочен outbox: EVENT_PUBLISH_FAILED issue создан.
    const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
      .map((c) => c[0] as { type: string })
      .find((i) => i.type === 'EVENT_PUBLISH_FAILED');
    expect(issue).toBeDefined();
  });

  // ── Dust-release failure после terminal fill ────────────────────────────────

  describe('dust reservation release (terminal fill через dust threshold)', () => {
    // order size 100, fill 99.995 → остаток 0.005 < dust threshold → FILLED.
    const DUST_FILL_SIZE = '99.995';

    it('BUY: сбой dust release → RECONCILIATION_REQUIRED, issue, markApplied НЕ вызван, Err', async () => {
      const portfolio = makePortfolioMock();
      (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('cannot unfreeze dust')),
      );
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new ProcessFillUseCase({ ...deps, portfolioService, reconciliationIssues });

      const result = await useCase.execute(makeFill({ size: makeQty(DUST_FILL_SIZE) } as never));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/dust/i);
      // Order уже terminal (saveSync) + Portfolio applied — retry бесполезен.
      expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
        FILL_ID,
        expect.stringContaining('DUST_RESERVATION_RELEASE_FAILED'),
      );
      expect(processedFillRepo.markApplied).not.toHaveBeenCalled();
      expect(processedFillRepo.markFailed).not.toHaveBeenCalled();
      // Флаги сняты — как на других partial-commit error paths.
      expect(orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith(ORDER_ID, FILL_ID);
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        type: string;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe(`reconciliation:fill:${String(FILL_ID)}:dust-reservation-release-failed`);
      expect(issue.type).toBe('ORDER_PORTFOLIO_DESYNC');
      expect(issue.context).toMatchObject({
        stage: 'dust-reservation-release-after-terminal-fill',
        side: 'BUY',
        remainingQty: '0.005',
        orderId: String(ORDER_ID),
      });
    });

    it('SELL: сбой dust release → RECONCILIATION_REQUIRED, issue, Err', async () => {
      const sellOrder = (() => {
        const r = Order.create({
          id: ORDER_ID,
          asset: ASSET_ID,
          side: 'SELL',
          price: makePrice('0.65') as never,
          size: makeQty('100') as never,
          timestamp: { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '2024-01-01T00:00:00.000Z' } as never,
        });
        if (!r.ok) throw new Error('Cannot create Order');
        const accepted = r.value.accept();
        if (!accepted.ok) throw new Error('Cannot accept Order');
        accepted.value.pullEvents();
        return accepted.value;
      })();

      const sellPortfolio: Portfolio = {
        ...makePortfolioMock(),
        getPosition: jest.fn<Portfolio['getPosition']>().mockReturnValue({
          instrumentId: ASSET_ID as unknown as InstrumentId,
          quantity: makeQty('100'),
          averageEntryPrice: makePrice('0.65'),
          side: 'LONG',
          isClosed: () => false,
        } as never),
      } as unknown as Portfolio;
      (sellPortfolio.applyCredit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(sellPortfolio));
      (sellPortfolio.upsertPosition as ReturnType<typeof jest.fn>).mockReturnValue(sellPortfolio);
      // Основной release в applyFill (fillQty=99.995) успешен, а dust release
      // остатка (0.005) падает — чтобы тест дошёл именно до dust-ветки.
      // (Task 6 сделал основной SELL release строгим: если бы падал ОН, applyFill
      //  вернул бы Err раньше — отдельный тест ниже это покрывает.)
      (sellPortfolio.releaseTokenReservation as ReturnType<typeof jest.fn>)
        .mockReturnValueOnce(Ok(sellPortfolio))
        .mockReturnValue(Err(new TradingError('cannot release token dust')));
      const store = makePortfolioStore(sellPortfolio);
      const portfolioService = new PortfolioService(store, logger);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(sellOrder),
        orderStateStore: makeOrderStateStore(sellOrder),
        portfolioService,
        reconciliationIssues,
      });

      const result = await useCase.execute(
        makeFill({ side: 'SELL', size: makeQty(DUST_FILL_SIZE) } as never),
      );

      expect(result.ok).toBe(false);
      expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
        FILL_ID,
        expect.stringContaining('DUST_RESERVATION_RELEASE_FAILED'),
      );
      expect(processedFillRepo.markApplied).not.toHaveBeenCalled();
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe(`reconciliation:fill:${String(FILL_ID)}:dust-reservation-release-failed`);
      expect(issue.context).toMatchObject({ side: 'SELL', remainingQty: '0.005' });
    });

    it('успешный dust release → Ok, markApplied вызван', async () => {
      const portfolio = makePortfolioMock();
      (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(Ok(portfolio));
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const useCase = new ProcessFillUseCase({ ...deps, portfolioService });

      const result = await useCase.execute(makeFill({ size: makeQty(DUST_FILL_SIZE) } as never));

      expect(result.ok).toBe(true);
      expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
      expect(processedFillRepo.markApplied).toHaveBeenCalledWith(FILL_ID);
    });

    it('нет dust (fill не делает ордер terminal) → release не вызывается', async () => {
      const portfolio = makePortfolioMock();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const useCase = new ProcessFillUseCase({ ...deps, portfolioService });

      const result = await useCase.execute(makeFill()); // 50 из 100 — не terminal

      expect(result.ok).toBe(true);
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    });
  });

  // ── SELL строгий release в applyFill (Task 6) ───────────────────────────────

  describe('SELL token reservation release строгий (local order path)', () => {
    /** SELL order (найден, OPEN) для local-order path */
    function makeSellOrder(): Order {
      const r = Order.create({
        id: ORDER_ID,
        asset: ASSET_ID,
        side: 'SELL',
        price: makePrice('0.65') as never,
        size: makeQty('100') as never,
        timestamp: { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '2024-01-01T00:00:00.000Z' } as never,
      });
      if (!r.ok) throw new Error('Cannot create Order');
      const accepted = r.value.accept();
      if (!accepted.ok) throw new Error('Cannot accept Order');
      accepted.value.pullEvents();
      return accepted.value;
    }

    /** SELL portfolio с позицией и заданным поведением releaseTokenReservation */
    function makeSellPortfolio(releaseFails: boolean): Portfolio {
      const p: Portfolio = {
        ...makePortfolioMock(),
        getPosition: jest.fn<Portfolio['getPosition']>().mockReturnValue({
          instrumentId: ASSET_ID as unknown as InstrumentId,
          quantity: makeQty('100'),
          averageEntryPrice: makePrice('0.65'),
          side: 'LONG',
          isClosed: () => false,
        } as never),
      } as unknown as Portfolio;
      (p.applyCredit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
      (p.applyDirectDebit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
      (p.upsertPosition as ReturnType<typeof jest.fn>).mockReturnValue(p);
      (p.releaseTokenReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        releaseFails ? Err(new TradingError('token reservation missing')) : Ok(p),
      );
      return p;
    }

    it('local SELL fill без токенной резервации → applyFill Err → RECONCILIATION_REQUIRED (ORDER_PORTFOLIO_DESYNC)', async () => {
      const sellOrder = makeSellOrder();
      const sellPortfolio = makeSellPortfolio(true); // release всегда падает
      const store = makePortfolioStore(sellPortfolio);
      const portfolioService = new PortfolioService(store, logger);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(sellOrder),
        orderStateStore: makeOrderStateStore(sellOrder),
        portfolioService,
        reconciliationIssues,
      });

      // Частичный fill (50 из 100) — ордер остаётся OPEN, dust-ветки нет.
      const result = await useCase.execute(makeFill({ side: 'SELL', size: makeQty('50') } as never));

      expect(result.ok).toBe(false);
      // applyFill упал строго на SELL release → десинк ловится РАНЬШЕ dust.
      expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
        FILL_ID,
        expect.stringContaining('ORDER_PORTFOLIO_DESYNC'),
      );
      expect(processedFillRepo.markApplied).not.toHaveBeenCalled();
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as { id: string };
      expect(issue.id).toBe(`reconciliation:fill:${String(FILL_ID)}:order-portfolio-desync`);
    });

    it('direct SELL fill (ордер не найден) без резервации всё равно успешен (best-effort credit)', async () => {
      const sellPortfolio = makeSellPortfolio(true); // release падает — но direct path толерантен
      const store = makePortfolioStore(sellPortfolio);
      const portfolioService = new PortfolioService(store, logger);
      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(undefined), // ордер не найден → direct-fill path
        orderStateStore: makeOrderStateStore(undefined),
        portfolioService,
      });

      const result = await useCase.execute(makeFill({ side: 'SELL', size: makeQty('50') } as never));

      // Direct path: release best-effort, USDC зачислен → Ok.
      expect(result.ok).toBe(true);
      expect(sellPortfolio.applyCredit).toHaveBeenCalled();
      expect(processedFillRepo.markApplied).toHaveBeenCalledWith(FILL_ID);
    });
  });

  // ── Ledger failure после Order+Portfolio commit ─────────────────────────────

  describe('ledger failure после commit (частичный commit)', () => {
    const throwingLedger = {
      recordFill: jest.fn(() => {
        throw new Error('ledger down');
      }),
    } as unknown as LedgerService;

    it('normal path: recordFill бросает → RECONCILIATION_REQUIRED (ORDER_PORTFOLIO_LEDGER_DESYNC), Err, markApplied НЕ вызван', async () => {
      const useCase = new ProcessFillUseCase({ ...deps, ledgerService: throwingLedger });

      const result = await useCase.execute(makeFill());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/ledger/i);
      // Order+Portfolio уже committed — retry бесполезен (duplicate fill defence),
      // поэтому терминальный RECONCILIATION_REQUIRED, а не retryable FAILED.
      expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
        FILL_ID,
        expect.stringContaining('ORDER_PORTFOLIO_LEDGER_DESYNC'),
      );
      expect(processedFillRepo.markFailed).not.toHaveBeenCalled();
      expect(processedFillRepo.markApplied).not.toHaveBeenCalled();
      // Флаги сняты — fill on-chain, stuck state недопустим.
      expect(orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith(ORDER_ID, FILL_ID);
    });

    it('normal path: при переданном reconciliationIssues создаётся issue order-portfolio-ledger-desync', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new ProcessFillUseCase({ ...deps, ledgerService: throwingLedger, reconciliationIssues });

      await useCase.execute(makeFill());

      expect(reconciliationIssues.add).toHaveBeenCalledTimes(1);
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        type: string;
        reason: string;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe(`reconciliation:fill:${String(FILL_ID)}:order-portfolio-ledger-desync`);
      expect(issue.type).toBe('ORDER_PORTFOLIO_DESYNC');
      expect(issue.reason).toContain('ORDER_PORTFOLIO_LEDGER_DESYNC');
      expect(issue.context).toMatchObject({ stage: 'ledger-record-after-portfolio-apply' });
    });

    it('direct fill path: recordFill бросает → RECONCILIATION_REQUIRED, Err, markApplied НЕ вызван', async () => {
      // Ордер не найден → direct-fill path: Portfolio применён через
      // applyDirectFill, retry повторно применил бы его (нет duplicate defence).
      orderRepo = makeOrderRepo(undefined);
      const directOrderStateStore = makeOrderStateStore(undefined);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo,
        orderStateStore: directOrderStateStore,
        ledgerService: throwingLedger,
        reconciliationIssues,
      });

      const result = await useCase.execute(makeFill());

      expect(result.ok).toBe(false);
      expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
        FILL_ID,
        expect.stringContaining('ORDER_PORTFOLIO_LEDGER_DESYNC'),
      );
      expect(processedFillRepo.markFailed).not.toHaveBeenCalled();
      expect(processedFillRepo.markApplied).not.toHaveBeenCalled();
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe(`reconciliation:fill:${String(FILL_ID)}:order-portfolio-ledger-desync`);
      expect(issue.context).toMatchObject({ stage: 'ledger-record-after-direct-fill-portfolio-apply' });
    });
  });

  // ── Portfolio не найден ───────────────────────────────────────────────────

  it('возвращает Err если portfolio не найден', async () => {
    const emptyStore: IPortfolioStore = {
      get: jest.fn<IPortfolioStore['get']>().mockReturnValue(undefined),
      save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
      getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
    };
    const portfolioService = new PortfolioService(emptyStore, logger);
    const useCase = new ProcessFillUseCase({ ...deps, portfolioService });
    const result = await useCase.execute(makeFill());
    expect(result.ok).toBe(false);
  });

  it('помечает fill как RECONCILIATION_REQUIRED (не FAILED) с префиксом ORDER_PORTFOLIO_DESYNC, если portfolio падает после того, как order уже сохранён', async () => {
    const emptyStore: IPortfolioStore = {
      get: jest.fn<IPortfolioStore['get']>().mockReturnValue(undefined),
      save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
      getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
    };
    const portfolioService = new PortfolioService(emptyStore, logger);
    const useCase = new ProcessFillUseCase({ ...deps, portfolioService });

    const result = await useCase.execute(makeFill());

    // Первая попытка (реальный сбой) всё ещё возвращает Err — это не no-op,
    // это первое обнаружение desync. Ok/no-op применяется только к ПОВТОРНОМУ
    // execute() того же fillId (см. следующий тест) через begin() RECONCILIATION_REQUIRED.
    expect(result.ok).toBe(false);
    // Order уже сохранён (saveSync) ДО того, как выяснилось, что portfolio не найден.
    expect(orderStateStore.saveSync).toHaveBeenCalled();
    // markReconciliationRequired, а НЕ markFailed — retry такого fillId бесполезен (см. doc порта).
    expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
      FILL_ID,
      expect.stringContaining('ORDER_PORTFOLIO_DESYNC'),
    );
    expect(processedFillRepo.markFailed).not.toHaveBeenCalled();
  });

  it('при RECONCILIATION_REQUIRED дополнительно создаёт reconciliation issue (если repo передан)', async () => {
    const emptyStore: IPortfolioStore = {
      get: jest.fn<IPortfolioStore['get']>().mockReturnValue(undefined),
      save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
      getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
    };
    const portfolioService = new PortfolioService(emptyStore, logger);
    const reconciliationIssues = makeReconciliationIssueRepo();
    const useCase = new ProcessFillUseCase({ ...deps, portfolioService, reconciliationIssues });

    const result = await useCase.execute(makeFill());

    expect(result.ok).toBe(false);
    expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
      FILL_ID,
      expect.stringContaining('ORDER_PORTFOLIO_DESYNC'),
    );
    expect(reconciliationIssues.add).toHaveBeenCalledTimes(1);
    const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
      id: string;
      type: string;
      status: string;
      reason: string;
      fillId: unknown;
      orderId: unknown;
      accountId: unknown;
      createdAt: Date;
      context?: Record<string, unknown>;
    };
    // Детерминированный id — повторный add того же сценария идемпотентен.
    expect(issue.id).toBe(`reconciliation:fill:${String(FILL_ID)}:order-portfolio-desync`);
    expect(issue.type).toBe('ORDER_PORTFOLIO_DESYNC');
    expect(issue.status).toBe('OPEN');
    // reason совпадает с тем, что передан в markReconciliationRequired.
    expect(issue.reason).toContain('ORDER_PORTFOLIO_DESYNC');
    expect(issue.fillId).toBe(FILL_ID);
    expect(issue.orderId).toBe(ORDER_ID);
    expect(issue.accountId).toBe(ACCOUNT_ID);
    expect(issue.createdAt).toBeInstanceOf(Date);
    expect(issue.context).toMatchObject({ stage: 'portfolio-apply-after-order-saved' });
  });

  it('сбой reconciliationIssues.add не маскирует исходную ошибку: markReconciliationRequired вызван, результат прежний Err', async () => {
    const emptyStore: IPortfolioStore = {
      get: jest.fn<IPortfolioStore['get']>().mockReturnValue(undefined),
      save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
      getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
    };
    const portfolioService = new PortfolioService(emptyStore, logger);
    const reconciliationIssues = makeReconciliationIssueRepo();
    (reconciliationIssues.add as ReturnType<typeof jest.fn>).mockImplementation(() =>
      Promise.reject(new Error('issue store down')),
    );
    const useCase = new ProcessFillUseCase({ ...deps, portfolioService, reconciliationIssues });

    const result = await useCase.execute(makeFill());

    // Результат тот же, что и без reconciliationIssues: Err про portfolio, не про issue store.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/portfolio/i);
    expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
      FILL_ID,
      expect.stringContaining('ORDER_PORTFOLIO_DESYNC'),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to add reconciliation issue',
      expect.objectContaining({ fillId: String(FILL_ID) }),
    );
  });

  it('begin() RECONCILIATION_REQUIRED → execute() возвращает Ok (no-op), не мутирует Order/Portfolio/Ledger повторно', async () => {
    processedFillRepo = makeProcessedFillRepo({ outcome: 'RECONCILIATION_REQUIRED' });
    const useCase = new ProcessFillUseCase({ ...deps, processedFillRepo });

    const result = await useCase.execute(makeFill());

    // Ok, а не Err: caller (WS handler / ReconcileTradesUseCase) не должен
    // трактовать повторный вызов как retryable ошибку — состояние уже известно
    // как нерешённое, требуется ручная реконсиляция, а не автоматический retry.
    expect(result.ok).toBe(true);
    expect(orderRepo.get).not.toHaveBeenCalled();
    expect(orderStateStore.saveSync).not.toHaveBeenCalled();
    expect(processedFillRepo.markApplied).not.toHaveBeenCalled();
    expect(processedFillRepo.markFailed).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ORDER_PORTFOLIO_DESYNC'),
      expect.objectContaining({ fillId: String(FILL_ID) }),
    );
  });

  // ── SELL fill ─────────────────────────────────────────────────────────────

  it('обрабатывает SELL fill корректно', async () => {
    const sellFill = makeFill({ side: 'SELL' } as never);
    const sellOrder = (() => {
      const r = Order.create({
        id: ORDER_ID,
        asset: ASSET_ID,
        side: 'SELL',
        price: makePrice('0.65') as never,
        size: makeQty('100') as never,
        timestamp: { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '2024-01-01T00:00:00.000Z' } as never,
      });
      if (!r.ok) throw new Error('Cannot create Order');
      const accepted = r.value.accept();
      if (!accepted.ok) throw new Error('Cannot accept Order');
      accepted.value.pullEvents();
      return accepted.value;
    })();

    // Для SELL необходима существующая позиция в Portfolio
    const sellPortfolioMock: Portfolio = {
      ...makePortfolioMock(),
      getPosition: jest.fn<Portfolio['getPosition']>().mockReturnValue({
        instrumentId: ASSET_ID as unknown as InstrumentId,
        quantity: makeQty('100'),
        averageEntryPrice: makePrice('0.65'),
        side: 'LONG',
        isClosed: () => false,
      } as never),
    } as unknown as Portfolio;
    (sellPortfolioMock.applyCredit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(sellPortfolioMock));
    (sellPortfolioMock.upsertPosition as ReturnType<typeof jest.fn>).mockReturnValue(sellPortfolioMock);
    const sellPortfolioStore = makePortfolioStore(sellPortfolioMock);
    const sellPortfolioService = new PortfolioService(sellPortfolioStore, logger);

    orderRepo = makeOrderRepo(sellOrder);
    const useCase = new ProcessFillUseCase({ ...deps, orderStateStore: makeOrderStateStore(sellOrder), orderRepo, portfolioService: sellPortfolioService });
    const result = await useCase.execute(sellFill);
    expect(result.ok).toBe(true);
  });

  // ── Held-reservation recovery path (Stage 2) ─────────────────────────────────

  describe('held-reservation recovery path', () => {
    const CLIENT_ID = 'client-1' as unknown as OrderId;
    // ВАЖНО: instrumentId записи journal обязан совпадать с инструментом fill
    // (assetIdToInstrumentId(ASSET_ID) === 'token-abc') — иначе prevalidation
    // held-fill корректно заблокирует потребление (Этап 3).
    const INSTRUMENT_ID = 'token-abc' as unknown as InstrumentId;

    /** Seed submission journal с held BUY-резервацией под venueOrderId=ORDER_ID. */
    async function seedHeldBuy(
      submissions: InMemoryOrderSubmissionRepository,
      initial: string,
    ): Promise<void> {
      await submissions.begin({
        clientOrderId: CLIENT_ID, accountId: ACCOUNT_ID, instrumentId: INSTRUMENT_ID,
        fingerprint: 'fp', side: 'BUY', orderPrice: '0.65', requestedSize: '100', now: new Date(),
      });
      await submissions.markReservationHeld(CLIENT_ID, initial, new Date());
      await submissions.markVenueAccepted(CLIENT_ID, ORDER_ID, new Date());
    }

    it('Order отсутствует + held-резервация → held path (applyDebit из reserved, НЕ applyDirectDebit)', async () => {
      const portfolio = makePortfolioMock();
      const store = makePortfolioStore(portfolio);
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeldBuy(submissions, '65');

      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(undefined),
        portfolioService: new PortfolioService(store, logger),
        submissions,
      });
      const result = await useCase.execute(makeFill()); // BUY 50 @ 0.65
      expect(result.ok).toBe(true);
      // Held path: потребляет reserved (applyDebit), НЕ available (applyDirectDebit).
      expect(portfolio.applyDebit).toHaveBeenCalled();
      expect(portfolio.applyDirectDebit).not.toHaveBeenCalled();
    });

    it('held partial fill → journal PARTIALLY_SETTLED, remaining уменьшается на notional', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeldBuy(submissions, '65');
      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(undefined),
        submissions,
      });
      await useCase.execute(makeFill()); // consume 0.65 * 50 = 32.5
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation).toMatchObject({
        consumed: '32.5', remaining: '32.5', status: 'PARTIALLY_SETTLED',
      });
    });

    it('held full fill → journal SETTLED (remaining 0)', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeldBuy(submissions, '65');
      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(undefined),
        submissions,
      });
      await useCase.execute(makeFill({ size: makeQty('100') })); // consume 0.65 * 100 = 65
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation).toMatchObject({ remaining: '0', consumed: '65', status: 'SETTLED' });
    });

    it('два partial fill с разными fillId полностью закрывают резервацию', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeldBuy(submissions, '65');
      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(undefined),
        processedFillRepo: makeProcessedFillRepo(), // ACQUIRED для обоих
        submissions,
      });
      await useCase.execute(makeFill({ id: 'f1' as unknown as FillId, size: makeQty('50') }));
      await useCase.execute(makeFill({ id: 'f2' as unknown as FillId, size: makeQty('50') }));
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation).toMatchObject({ remaining: '0', consumed: '65', status: 'SETTLED' });
    });

    it('duplicate fillId не потребляет резервацию повторно (idempotent journal)', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeldBuy(submissions, '65');
      // applyReservationTransition идемпотентен by operationId=fillId. Прямой
      // повторный transition тем же fillId не удваивает consumed.
      await submissions.applyReservationTransition(CLIENT_ID, { operationId: String(FILL_ID), consume: '32.5', now: new Date() });
      await submissions.applyReservationTransition(CLIENT_ID, { operationId: String(FILL_ID), consume: '32.5', now: new Date() });
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation.consumed).toBe('32.5');
    });

    it('external fill без execution record → direct path (applyDirectDebit)', async () => {
      const portfolio = makePortfolioMock();
      const store = makePortfolioStore(portfolio);
      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(undefined),
        portfolioService: new PortfolioService(store, logger),
        submissions: new InMemoryOrderSubmissionRepository(), // пусто
      });
      const result = await useCase.execute(makeFill());
      expect(result.ok).toBe(true);
      // Нет execution → direct path: списание из available.
      expect(portfolio.applyDirectDebit).toHaveBeenCalled();
      expect(portfolio.applyDebit).not.toHaveBeenCalled();
    });

    it('execution SETTLED → direct path (не held)', async () => {
      const portfolio = makePortfolioMock();
      const store = makePortfolioStore(portfolio);
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeldBuy(submissions, '65');
      // Полностью потребляем резервацию → SETTLED.
      await submissions.applyReservationTransition(CLIENT_ID, { operationId: 'prior', consume: '65', now: new Date() });

      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(undefined),
        portfolioService: new PortfolioService(store, logger),
        submissions,
      });
      const result = await useCase.execute(makeFill({ id: 'later' as unknown as FillId }));
      expect(result.ok).toBe(true);
      // SETTLED → нет held-резервации → direct path.
      expect(portfolio.applyDirectDebit).toHaveBeenCalled();
    });

    it('terminal Order + held-резервация → held path (не direct)', async () => {
      const portfolio = makePortfolioMock();
      const store = makePortfolioStore(portfolio);
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeldBuy(submissions, '65');

      // Order существует, но terminal (FILLED/CANCELLED).
      const terminalOrder = makeOrderOpen();
      const cancelled = terminalOrder.cancel();
      const order = cancelled.ok ? cancelled.value : terminalOrder;

      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(order),
        orderStateStore: makeOrderStateStore(order),
        portfolioService: new PortfolioService(store, logger),
        submissions,
      });
      const result = await useCase.execute(makeFill());
      expect(result.ok).toBe(true);
      // Terminal Order + held → held path (reserved consume), не direct.
      expect(portfolio.applyDebit).toHaveBeenCalled();
      expect(portfolio.applyDirectDebit).not.toHaveBeenCalled();
    });
  });

  // ── Fill processing blocks (Stage 6) ─────────────────────────────────────────

  describe('fill processing blocks', () => {
    it('успех → markFillProcessing + clearFillProcessing (блок снят)', async () => {
      const useCase = new ProcessFillUseCase(deps);
      await useCase.execute(makeFill());
      expect(deps.orderStateStore.markFillProcessing).toHaveBeenCalled();
      expect(deps.orderStateStore.clearFillProcessing).toHaveBeenCalledWith(FILL_ID);
    });

    it('Portfolio applyFill failure после saveSync → RECONCILIATION_REQUIRED, блок НЕ снят', async () => {
      const portfolio = makePortfolioMock();
      (portfolio.applyDebit as ReturnType<typeof jest.fn>).mockReturnValue(Err(new TradingError('debit failed')));
      const store = makePortfolioStore(portfolio);
      const useCase = new ProcessFillUseCase({ ...deps, portfolioService: new PortfolioService(store, logger) });
      const result = await useCase.execute(makeFill());
      expect(result.ok).toBe(false);
      expect(deps.orderStateStore.updateFillProcessingStatus).toHaveBeenCalledWith(FILL_ID, 'RECONCILIATION_REQUIRED');
      expect(deps.orderStateStore.clearFillProcessing).not.toHaveBeenCalled();
    });

    it('direct-fill Portfolio failure → FAILED_RETRYABLE, блок НЕ снят', async () => {
      const portfolio = makePortfolioMock();
      (portfolio.applyDirectDebit as ReturnType<typeof jest.fn>).mockReturnValue(Err(new TradingError('direct debit failed')));
      const store = makePortfolioStore(portfolio);
      const directStore = makeOrderStateStore(undefined);
      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(undefined),
        orderStateStore: directStore,
        portfolioService: new PortfolioService(store, logger),
      });
      const result = await useCase.execute(makeFill());
      expect(result.ok).toBe(false);
      expect(directStore.updateFillProcessingStatus).toHaveBeenCalledWith(FILL_ID, 'FAILED_RETRYABLE');
      expect(directStore.clearFillProcessing).not.toHaveBeenCalled();
    });

    it('event publish failure после commit → блок СНЯТ (fill APPLIED, не trading block)', async () => {
      const failingBus = makeEventBus();
      (failingBus.publishAll as ReturnType<typeof jest.fn>).mockRejectedValue(new Error('bus down') as never);
      const useCase = new ProcessFillUseCase({ ...deps, orderedEventOutbox: makeOutbox(failingBus) });
      await useCase.execute(makeFill());
      // Commit состоялся до publish → блок снят несмотря на сбой публикации.
      expect(deps.orderStateStore.clearFillProcessing).toHaveBeenCalledWith(FILL_ID);
    });
  });

  // ── Превалидация held-fill (Этап 3) ──────────────────────────────────────────

  describe('held-fill prevalidation (Этап 3)', () => {
    const CLIENT_ID = 'client-1' as unknown as OrderId;
    const HELD_INSTRUMENT_ID = 'token-abc' as unknown as InstrumentId;

    /** Seed журнала с held-резервацией под venueOrderId=ORDER_ID. */
    async function seedHeld(
      submissions: InMemoryOrderSubmissionRepository,
      opts: {
        side?: 'BUY' | 'SELL';
        initial?: string;
        accountId?: AccountId;
        instrumentId?: InstrumentId;
        orderPrice?: string;
        requestedSize?: string;
      } = {},
    ): Promise<void> {
      await submissions.begin({
        clientOrderId: CLIENT_ID,
        accountId: opts.accountId ?? ACCOUNT_ID,
        instrumentId: opts.instrumentId ?? HELD_INSTRUMENT_ID,
        fingerprint: 'fp',
        side: opts.side ?? 'BUY',
        orderPrice: opts.orderPrice ?? '0.65',
        requestedSize: opts.requestedSize ?? '100',
        now: new Date(),
      });
      await submissions.markReservationHeld(CLIENT_ID, opts.initial ?? '65', new Date());
      await submissions.markVenueAccepted(CLIENT_ID, ORDER_ID, new Date());
    }

    /** Собирает deps для held-сценария и возвращает шпионов. */
    function makeHeldDeps(submissions: InMemoryOrderSubmissionRepository): {
      useCase: ProcessFillUseCase;
      portfolio: Portfolio;
      store: IPortfolioStore;
      reconciliationIssues: IReconciliationIssueRepository;
      stateStore: IOrderStateStore;
      ledgerRecordFill: ReturnType<typeof jest.fn>;
    } {
      const portfolio = makePortfolioMock();
      const store = makePortfolioStore(portfolio);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const stateStore = makeOrderStateStore(undefined);
      const ledgerService = new LedgerService(makeLogger());
      const ledgerRecordFill = jest.fn();
      (ledgerService as unknown as { recordFill: unknown }).recordFill = ledgerRecordFill;
      const useCase = new ProcessFillUseCase({
        ...deps,
        orderRepo: makeOrderRepo(undefined),
        orderStateStore: stateStore,
        portfolioService: new PortfolioService(store, logger),
        ledgerService,
        submissions,
        reconciliationIssues,
      });
      return { useCase, portfolio, store, reconciliationIssues, stateStore, ledgerRecordFill };
    }

    /** Общие проверки «никаких мутаций + reconciliation-блок». */
    async function expectBlockedWithoutMutations(
      ctx: ReturnType<typeof makeHeldDeps>,
      submissions: InMemoryOrderSubmissionRepository,
      result: Awaited<ReturnType<ProcessFillUseCase['execute']>>,
      expectedRemaining: string,
    ): Promise<void> {
      expect(result.ok).toBe(false);
      // Portfolio: никаких балансовых мутаций.
      expect(ctx.portfolio.applyDebit).not.toHaveBeenCalled();
      expect(ctx.portfolio.applyDirectDebit).not.toHaveBeenCalled();
      expect(ctx.portfolio.applyCredit).not.toHaveBeenCalled();
      expect(ctx.store.save).not.toHaveBeenCalled();
      // Ledger не записан.
      expect(ctx.ledgerRecordFill).not.toHaveBeenCalled();
      // Journal amounts не тронуты.
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation.remaining).toBe(expectedRemaining);
      expect(record?.reservation.consumed).toBe('0');
      // Processed fill → RECONCILIATION_REQUIRED, processing-блок сохранён.
      expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalled();
      expect(ctx.stateStore.updateFillProcessingStatus).toHaveBeenCalledWith(FILL_ID, 'RECONCILIATION_REQUIRED');
      expect(ctx.stateStore.clearFillProcessing).not.toHaveBeenCalled();
      // Issue с фактическими значениями.
      expect(ctx.reconciliationIssues.add).toHaveBeenCalled();
    }

    it('held fill с чужим accountId — никаких мутаций, reconciliation-блок', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeld(submissions, { accountId: 'acc-OTHER' as unknown as AccountId });
      const ctx = makeHeldDeps(submissions);
      const result = await ctx.useCase.execute(makeFill());
      await expectBlockedWithoutMutations(ctx, submissions, result, '65');
    });

    it('held fill с неправильным instrument — никаких мутаций', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeld(submissions, { instrumentId: 'token-OTHER' as unknown as InstrumentId });
      const ctx = makeHeldDeps(submissions);
      const result = await ctx.useCase.execute(makeFill());
      await expectBlockedWithoutMutations(ctx, submissions, result, '65');
    });

    it('held fill с неправильной side — никаких мутаций', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeld(submissions, { side: 'SELL', initial: '100' }); // журнал SELL, fill BUY
      const ctx = makeHeldDeps(submissions);
      const result = await ctx.useCase.execute(makeFill()); // BUY
      await expectBlockedWithoutMutations(ctx, submissions, result, '100');
    });

    it('held fill больше remaining — Portfolio и Ledger не изменены', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeld(submissions, { initial: '20' }); // remaining 20 < consume 32.5
      const ctx = makeHeldDeps(submissions);
      const result = await ctx.useCase.execute(makeFill()); // BUY 50 @ 0.65 = 32.5
      await expectBlockedWithoutMutations(ctx, submissions, result, '20');
    });

    it('cumulative fill size больше effective/requested size — блок', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      // Журнал: size 40, но capital 65 (несогласованная запись) → size-проверка ловит.
      await seedHeld(submissions, { requestedSize: '40', initial: '65' });
      const ctx = makeHeldDeps(submissions);
      const result = await ctx.useCase.execute(makeFill()); // fill size 50 > 40
      await expectBlockedWithoutMutations(ctx, submissions, result, '65');
    });

    it('reservation RECONCILIATION_REQUIRED: ни held, ни direct path — fill блокируется', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeld(submissions);
      await submissions.applyReservationTransition(CLIENT_ID, {
        operationId: 'attempt:1:reconcile', status: 'RECONCILIATION_REQUIRED', now: new Date(),
      });
      const ctx = makeHeldDeps(submissions);
      const result = await ctx.useCase.execute(makeFill());
      expect(result.ok).toBe(false);
      // Ни held-потребление, ни direct-дебет.
      expect(ctx.portfolio.applyDebit).not.toHaveBeenCalled();
      expect(ctx.portfolio.applyDirectDebit).not.toHaveBeenCalled();
      expect(ctx.ledgerRecordFill).not.toHaveBeenCalled();
      expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
        FILL_ID, expect.stringContaining('RESERVATION_RECONCILIATION_REQUIRED'),
      );
      expect(ctx.stateStore.updateFillProcessingStatus).toHaveBeenCalledWith(FILL_ID, 'RECONCILIATION_REQUIRED');
      expect(ctx.stateStore.clearFillProcessing).not.toHaveBeenCalled();
    });

    it('held path: applyReservationTransition отклоняет Promise → RECONCILIATION_REQUIRED, manual block, НЕ APPLIED', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedHeld(submissions);
      jest.spyOn(submissions, 'applyReservationTransition').mockRejectedValue(new Error('journal store down'));
      const ctx = makeHeldDeps(submissions);

      // НЕ бросает — rejection репозитория пойман exception boundary.
      const result = await ctx.useCase.execute(makeFill());

      expect(result.ok).toBe(false);
      expect(processedFillRepo.markApplied).not.toHaveBeenCalled();
      expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
        FILL_ID, expect.stringContaining('RESERVATION_JOURNAL_DESYNC'),
      );
      expect(ctx.stateStore.updateFillProcessingStatus).toHaveBeenCalledWith(FILL_ID, 'RECONCILIATION_REQUIRED');
      // Typed manual block поставлен (двухслойная защита при недоступном журнале).
      expect(ctx.stateStore.markManualReconciliationBlock).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER_ID }),
      );
    });

    it('reservation kind mismatch: PortfolioService defensive-проверка возвращает Err без мутаций', async () => {
      // Прямой unit-тест defensive-проверки (caller-валидация обойдена).
      const portfolio = makePortfolioMock();
      const store = makePortfolioStore(portfolio);
      const service = new PortfolioService(store, logger);
      const r = service.applyFillAgainstHeldReservation({
        fill: makeFill(), // BUY
        orderPrice: new Decimal('0.65'),
        reservationKind: 'TOKENS', // BUY обязан быть USDC
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/kind mismatch/i);
      expect(portfolio.applyDebit).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
    });
  });

  // ── Commit-critical journal на normal fill (Этап 4) ──────────────────────────

  describe('normal fill journal commit-critical (Этап 4)', () => {
    const CLIENT_ID = 'client-1' as unknown as OrderId;
    const NORMAL_INSTRUMENT_ID = 'token-abc' as unknown as InstrumentId;

    /** Seed журнала под live local Order (venueOrderId=ORDER_ID). */
    async function seedJournal(
      submissions: InMemoryOrderSubmissionRepository,
      initial = '65',
    ): Promise<void> {
      await submissions.begin({
        clientOrderId: CLIENT_ID, accountId: ACCOUNT_ID, instrumentId: NORMAL_INSTRUMENT_ID,
        fingerprint: 'fp', side: 'BUY', orderPrice: '0.65', requestedSize: '100', now: new Date(),
      });
      await submissions.markReservationHeld(CLIENT_ID, initial, new Date());
      await submissions.markCommitted(CLIENT_ID, ORDER_ID, new Date());
    }

    it('partial normal fill: journal consume attempt-scoped, PARTIALLY_SETTLED', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedJournal(submissions);
      const useCase = new ProcessFillUseCase({ ...deps, submissions });
      const result = await useCase.execute(makeFill()); // BUY 50 @ 0.65 → consume 32.5
      expect(result.ok).toBe(true);
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation).toMatchObject({
        consumed: '32.5', remaining: '32.5', status: 'PARTIALLY_SETTLED',
      });
    });

    it('terminal normal fill: consume и release выполняются ОДНИМ transition → SETTLED', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedJournal(submissions);
      const applySpy = jest.spyOn(submissions, 'applyReservationTransition');
      const useCase = new ProcessFillUseCase({ ...deps, submissions });
      // Полный fill: size 100 → Order terminal (FILLED), consume 65, release 0.
      const result = await useCase.execute(makeFill({ size: makeQty('100') }));
      expect(result.ok).toBe(true);
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation).toMatchObject({ remaining: '0', status: 'SETTLED' });
      // Ровно ОДИН transition с operationId ...:terminal (не отдельные consume + settle).
      const terminalCalls = applySpy.mock.calls.filter(
        (c) => (c[1] as { operationId: string }).operationId === `attempt:1:fill:${String(FILL_ID)}:terminal`,
      );
      expect(terminalCalls).toHaveLength(1);
      expect(applySpy).toHaveBeenCalledTimes(1);
    });

    it('terminal fill с dust-остатком: единый transition consume+release → SETTLED', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedJournal(submissions);
      const useCase = new ProcessFillUseCase({ ...deps, submissions });
      // Fill 99.995 при size 100 → dust 0.005 < 0.01 → Order terminal.
      const result = await useCase.execute(makeFill({ size: makeQty('99.995') }));
      expect(result.ok).toBe(true);
      const record = await submissions.get(CLIENT_ID);
      // consume = 0.65 × 99.995 = 64.99675; release = 65 − 64.99675 = 0.00325.
      expect(record?.reservation).toMatchObject({ remaining: '0', status: 'SETTLED' });
      expect(record?.reservation.consumed).toBe('64.99675');
      expect(record?.reservation.released).toBe('0.00325');
    });

    it('journal consume failure после business commit: НЕ APPLIED, блок остаётся, RESERVATION_JOURNAL_DESYNC issue', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      // Журнал под-зарезервирован: consume 32.5 > remaining 10 → OVER_CONSUME.
      await seedJournal(submissions, '10');
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new ProcessFillUseCase({ ...deps, submissions, reconciliationIssues });
      const result = await useCase.execute(makeFill());
      expect(result.ok).toBe(false);
      expect(processedFillRepo.markApplied).not.toHaveBeenCalled();
      expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
        FILL_ID, expect.stringContaining('RESERVATION_JOURNAL_DESYNC'),
      );
      expect(deps.orderStateStore.updateFillProcessingStatus).toHaveBeenCalledWith(FILL_ID, 'RECONCILIATION_REQUIRED');
      expect(deps.orderStateStore.clearFillProcessing).not.toHaveBeenCalled();
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { type: string })
        .find((i) => i.type === 'RESERVATION_JOURNAL_DESYNC');
      expect(issue).toBeDefined();
    });

    it('journal failure после Portfolio/Ledger: повторный execute НЕ применяет fill заново', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await seedJournal(submissions, '10'); // OVER_CONSUME на первом вызове
      const portfolio = makePortfolioMock();
      const store = makePortfolioStore(portfolio);
      // Реалистичный idempotency-репозиторий: после markReconciliationRequired
      // begin() возвращает RECONCILIATION_REQUIRED.
      let reconciled = false;
      const realisticRepo: IProcessedFillRepository = {
        ...makeProcessedFillRepo(),
        begin: jest.fn<IProcessedFillRepository['begin']>().mockImplementation(async () =>
          reconciled ? { outcome: 'RECONCILIATION_REQUIRED' } : { outcome: 'ACQUIRED', isRetry: false },
        ),
        markReconciliationRequired: jest.fn<IProcessedFillRepository['markReconciliationRequired']>()
          .mockImplementation(async () => { reconciled = true; }),
      };
      const useCase = new ProcessFillUseCase({
        ...deps,
        submissions,
        processedFillRepo: realisticRepo,
        portfolioService: new PortfolioService(store, logger),
      });

      const first = await useCase.execute(makeFill());
      expect(first.ok).toBe(false);
      expect(portfolio.applyDebit).toHaveBeenCalledTimes(1); // business commit был

      const second = await useCase.execute(makeFill());
      // Повторный вызов — no-op (Ok), Portfolio НЕ мутируется повторно.
      expect(second.ok).toBe(true);
      expect(portfolio.applyDebit).toHaveBeenCalledTimes(1);
    });

    it('unexpected PREcommit exception (orderRepo.get отклоняет Promise) → retryable, markers сохранены, повторный execute применяет fill', async () => {
      // Stateful repo: FAILED → retry разрешён.
      const status = new Map<string, string>();
      const statefulRepo = {
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

      const failingOrderRepo = makeOrderRepo(makeOrderOpen());
      (failingOrderRepo.get as ReturnType<typeof jest.fn>)
        .mockRejectedValueOnce(new Error('repo connection reset') as never);
      const useCase = new ProcessFillUseCase({ ...deps, orderRepo: failingOrderRepo, processedFillRepo: statefulRepo });

      // Первый вызов: НЕ бросает — Err (retryable), мутаций не было.
      const first = await useCase.execute(makeFill());
      expect(first.ok).toBe(false);
      expect(statefulRepo.markFailed).toHaveBeenCalledWith(
        FILL_ID, expect.stringContaining('UNEXPECTED_EXCEPTION_PRECOMMIT'),
      );
      expect(statefulRepo.markReconciliationRequired).not.toHaveBeenCalled();
      expect(deps.orderStateStore.updateFillProcessingStatus).toHaveBeenCalledWith(FILL_ID, 'FAILED_RETRYABLE');
      // Venue MATCHED/in-flight evidence НЕ снимается generic exception path.
      expect(deps.orderStateStore.clearOrderFillMatched).not.toHaveBeenCalled();
      expect(deps.orderStateStore.clearInFlightFill).not.toHaveBeenCalled();

      // Retry: repo восстановился → fill применяется.
      const second = await useCase.execute(makeFill());
      expect(second.ok).toBe(true);
      expect(statefulRepo.markApplied).toHaveBeenCalledTimes(1);
    });

    it('unexpected POSTcommit exception (applyFill бросает после saveSync) → terminal reconciliation + manual block, markers сохранены', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      // portfolioService.applyFill БРОСАЕТ (не Err) — после saveSync (ORDER_COMMITTED).
      const throwingPortfolioService = {
        applyFill: jest.fn(() => { throw new Error('portfolio store crashed'); }),
      } as unknown as ProcessFillDeps['portfolioService'];
      const useCase = new ProcessFillUseCase({
        ...deps,
        portfolioService: throwingPortfolioService,
        reconciliationIssues,
      });

      const result = await useCase.execute(makeFill());

      expect(result.ok).toBe(false);
      expect(processedFillRepo.markReconciliationRequired).toHaveBeenCalledWith(
        FILL_ID, expect.stringContaining('UNEXPECTED_EXCEPTION_POSTCOMMIT (phase=ORDER_COMMITTED)'),
      );
      expect(processedFillRepo.markFailed).not.toHaveBeenCalled();
      expect(deps.orderStateStore.updateFillProcessingStatus).toHaveBeenCalledWith(FILL_ID, 'RECONCILIATION_REQUIRED');
      // Manual block поставлен (частичный commit).
      expect(deps.orderStateStore.markManualReconciliationBlock).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER_ID }),
      );
      // Markers сохранены.
      expect(deps.orderStateStore.clearOrderFillMatched).not.toHaveBeenCalled();
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { id: string })
        .find((i) => i.id.endsWith(':unexpected-exception-postcommit'));
      expect(issue).toBeDefined();
    });

    it('begin() выполняется ВНУТРИ критической секции mutex (lease-fencing ordering)', async () => {
      const events: string[] = [];
      const trackingMutex = {
        runExclusive: jest.fn(async <T,>(_keys: readonly string[], fn: () => Promise<T>) => {
          events.push('mutex-enter');
          const r = await fn();
          events.push('mutex-exit');
          return r;
        }),
      } as unknown as IKeyedMutex;
      const trackingRepo = {
        ...makeProcessedFillRepo(),
        begin: jest.fn(async () => {
          events.push('begin');
          return { outcome: 'ACQUIRED' as const, isRetry: false };
        }),
      } as unknown as IProcessedFillRepository;
      const useCase = new ProcessFillUseCase({ ...deps, keyedMutex: trackingMutex, processedFillRepo: trackingRepo });

      await useCase.execute(makeFill());

      // begin строго между входом и выходом из mutex: воскресший worker
      // не может пронести «протухший» ACQUIRED через границу критсекции.
      expect(events[0]).toBe('mutex-enter');
      expect(events[1]).toBe('begin');
      expect(events[events.length - 1]).toBe('mutex-exit');
    });

    it('конкурентные execute одного fill (реальные mutex + idempotency repo): применяется РОВНО один раз, второй видит DUPLICATE', async () => {
      const portfolio = makePortfolioMock();
      const store = makePortfolioStore(portfolio);
      const realMutex = new InMemoryKeyedMutex();
      const realRepo = new InMemoryProcessedFillRepository();
      const useCase = new ProcessFillUseCase({
        ...deps,
        portfolioService: new PortfolioService(store, logger),
        keyedMutex: realMutex,
        processedFillRepo: realRepo,
      });

      const [first, second] = await Promise.all([
        useCase.execute(makeFill()),
        useCase.execute(makeFill()),
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      // Fill применён ровно один раз (второй вызов — DUPLICATE no-op под mutex).
      expect(portfolio.applyDebit).toHaveBeenCalledTimes(1);
      expect(await realRepo.getStatus(FILL_ID)).toBe('APPLIED');
    });

    it('journal NONE (резервация не фиксировалась) → sync пропускается, fill применяется', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      await submissions.begin({
        clientOrderId: CLIENT_ID, accountId: ACCOUNT_ID, instrumentId: NORMAL_INSTRUMENT_ID,
        fingerprint: 'fp', side: 'BUY', orderPrice: '0.65', requestedSize: '100', now: new Date(),
      });
      await submissions.markCommitted(CLIENT_ID, ORDER_ID, new Date());
      const useCase = new ProcessFillUseCase({ ...deps, submissions });
      const result = await useCase.execute(makeFill());
      expect(result.ok).toBe(true);
      expect(processedFillRepo.markApplied).toHaveBeenCalled();
    });
  });
});
