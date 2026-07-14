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
} from '@polymarket/ports';
import { pendingMatchFillId } from '@polymarket/ports';
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

  it('normal path: publishAll падает после commit → Ok (fill APPLIED, не retryable), EVENT_PUBLISH_FAILED в логе', async () => {
    const failingEventBus: IEventBus = {
      ...eventBus,
      publishAll: jest.fn<IEventBus['publishAll']>().mockRejectedValue(new Error('bus down')),
    };
    const useCase = new ProcessFillUseCase({ ...deps, eventBus: failingEventBus });

    const result = await useCase.execute(makeFill());

    // Fill уже committed и APPLIED — потеря уведомления не делает операцию
    // retryable: Ok, не Err.
    expect(result.ok).toBe(true);
    expect(processedFillRepo.markApplied).toHaveBeenCalledWith(FILL_ID);
    expect(processedFillRepo.markFailed).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('EVENT_PUBLISH_FAILED'),
      expect.objectContaining({ fillId: String(FILL_ID) }),
    );
  });

  it('direct fill path: publishAll падает после commit → Ok (fill APPLIED, не retryable), EVENT_PUBLISH_FAILED в логе', async () => {
    orderRepo = makeOrderRepo(undefined);
    const directOrderStateStore = makeOrderStateStore(undefined);
    const failingEventBus: IEventBus = {
      ...eventBus,
      publishAll: jest.fn<IEventBus['publishAll']>().mockRejectedValue(new Error('bus down')),
    };
    const useCase = new ProcessFillUseCase({
      ...deps,
      orderStateStore: directOrderStateStore,
      orderRepo,
      eventBus: failingEventBus,
    });

    const result = await useCase.execute(makeFill());

    expect(result.ok).toBe(true);
    expect(processedFillRepo.markApplied).toHaveBeenCalledWith(FILL_ID);
    expect(processedFillRepo.markFailed).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('EVENT_PUBLISH_FAILED'),
      expect.objectContaining({ fillId: String(FILL_ID) }),
    );
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
      // releaseTokenReservation падает — и best-effort внутри applyFill (толерантен),
      // и dust release после terminal (НЕ толерантен).
      (sellPortfolio.releaseTokenReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('cannot release token dust')),
      );
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
});
