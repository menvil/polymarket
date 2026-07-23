import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PlaceOrderUseCase } from '../src/PlaceOrderUseCase.js';
import { PortfolioService } from '../src/services/PortfolioService.js';
import type { PlaceOrderInput, PlaceOrderDeps } from '../src/PlaceOrderUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { IEventBus } from '@polymarket/event-bus';
import type {
  IOrderRepository,
  IExchangeClient,
  IPortfolioStore,
  IOrderStateStore,
  IKeyedMutex,
  IReconciliationIssueRepository,
  IOrderSubmissionRepository,
  OrderSubmissionRecord,
  CancelOrderResult,
} from '@polymarket/ports';
import { VersionConflictError, ExchangeError, emptyReservation, ReservationTransitionError } from '@polymarket/ports';
import type { IOrderRiskChecker, RiskViolationError } from '@polymarket/risk';
import { OrderRiskChecker, RiskPolicy } from '@polymarket/risk';
import type { IMarketCatalog, InstrumentInfo } from '@polymarket/ports';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { AccountId, AssetId, InstrumentId, OrderId } from '@polymarket/ids';
import { accountIdToString } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import { RiskViolationError as RiskViolationErrorClass } from '@polymarket/risk';
import { InMemoryOrderSubmissionRepository } from '../../../infrastructure/in-memory/src/InMemoryOrderSubmissionRepository.js';
import { InMemoryOrderedEventOutbox } from '../../../infrastructure/in-memory/src/InMemoryOrderedEventOutbox.js';
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

function makeClock(date = new Date('2024-01-01T00:00:00.000Z')): IClock {
  return { now: jest.fn<() => Date>().mockReturnValue(date) };
}

function makeEventBus(): IEventBus {
  return {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
    subscribe: jest.fn<IEventBus['subscribe']>().mockReturnValue(() => {}),
  };
}

/**
 * Реальный ordered outbox, публикующий в переданный eventBus.
 *
 * @remarks
 * PlaceOrderUseCase больше НЕ вызывает `eventBus.publishAll` напрямую: события
 * `enqueue`-ятся под lock и `flush`-ятся ПОСЛЕ lock через outbox. Помощник
 * связывает outbox.publish → eventBus.publishAll, поэтому assertion'ы на
 * `eventBus.publishAll` продолжают работать. `reconciliationIssues` (если
 * передан) — куда outbox положит EVENT_PUBLISH_FAILED при сбое публикации.
 */
function makeOutbox(
  bus: IEventBus,
  reconciliationIssues?: IReconciliationIssueRepository,
): InMemoryOrderedEventOutbox {
  return new InMemoryOrderedEventOutbox({
    publish: (events) => bus.publishAll(events as Parameters<IEventBus['publishAll']>[0]),
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

function makePortfolio(opts: { availableUsdc?: string } = {}): Portfolio {
  const available = new Decimal(opts.availableUsdc ?? '10000');
  const p: Portfolio = {
    accountId: 'acc-001' as unknown as AccountId,
    balance: {
      available: () => ({ value: () => available }),
      reserved: () => ({ value: () => new Decimal(0) }),
      total: () => ({ value: () => available }),
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
    upsertPosition: jest.fn<Portfolio['upsertPosition']>(),
    tokenReservations: new Map(),
  } as unknown as Portfolio;
  (p.reserveForOrder as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.reserveTokensForOrder as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.releaseTokenReservation as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  return p;
}

function makePortfolioStore(portfolio?: Portfolio): IPortfolioStore {
  const p = portfolio ?? makePortfolio();
  return {
    get: jest.fn<IPortfolioStore['get']>().mockReturnValue(p),
    save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
    getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
  };
}

function makeOrderRepo(): IOrderRepository {
  return {
    get: jest.fn().mockImplementation(() => Promise.resolve(undefined)) as unknown as IOrderRepository['get'],
    getVersion: jest.fn().mockImplementation(() => Promise.resolve(0)) as unknown as IOrderRepository['getVersion'],
    getWithVersion: jest.fn().mockImplementation(() => Promise.resolve(undefined)) as unknown as IOrderRepository['getWithVersion'],
    save: jest.fn().mockImplementation(() => Promise.resolve(Ok(undefined))) as unknown as IOrderRepository['save'],
    deleteIfVersion: jest.fn().mockImplementation(() => Promise.resolve(Ok({ status: 'DELETED' }))) as unknown as IOrderRepository['deleteIfVersion'],
    deleteIfState: jest.fn().mockImplementation(() => Promise.resolve(Ok({ status: 'DELETED' }))) as unknown as IOrderRepository['deleteIfState'],
    getByStrategyId: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getByStrategyId'],
    countByStrategyId: jest.fn().mockImplementation(() => Promise.resolve(0)) as unknown as IOrderRepository['countByStrategyId'],
    getAll: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getAll'],
    getByMarketId: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getByMarketId'],
  };
}

function makeExchangeClient(orderId?: OrderId): IExchangeClient {
  const id = orderId ?? ('exchange-order-1' as unknown as OrderId);
  return {
    submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
      Ok({ status: 'OPEN', orderId: id, effectiveSize: makeQty('100'), remainingSize: makeQty('100') }),
    ),
    cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
    getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
    getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
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

/** Полная submission-запись для стабов (все обязательные поля включая reservation). */
function makeSubmissionRecord(
  overrides: Partial<OrderSubmissionRecord> = {},
): OrderSubmissionRecord {
  return {
    clientOrderId: ORDER_ID,
    status: 'SUBMITTING',
    accountId: ACCOUNT_ID,
    instrumentId: INSTRUMENT_ID,
    attempt: 1,
    fingerprint: 'fp',
    side: 'BUY',
    orderPrice: '0.5',
    requestedSize: '10',
    reservation: emptyReservation('USDC'),
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Полный стаб IOrderSubmissionRepository со всеми методами (включая reservation
 * journal). Дефолты: begin→ACQUIRED, get/findByVenueOrderId→undefined,
 * mark-методы/transition→no-op/Ok. Переопределяй нужные методы через `overrides`.
 */
function makeSubmissionsStub(
  overrides: Partial<IOrderSubmissionRepository> = {},
): IOrderSubmissionRepository {
  return {
    begin: jest.fn<IOrderSubmissionRepository['begin']>().mockResolvedValue({ outcome: 'ACQUIRED' }),
    markReservationHeld: jest.fn<IOrderSubmissionRepository['markReservationHeld']>()
      .mockImplementation(async () => Ok(makeSubmissionRecord())),
    setEffectiveSize: jest.fn<IOrderSubmissionRepository['setEffectiveSize']>().mockResolvedValue(undefined),
    applyReservationTransition: jest.fn<IOrderSubmissionRepository['applyReservationTransition']>()
      .mockImplementation(async () => Ok(makeSubmissionRecord())),
    markVenueAccepted: jest.fn<IOrderSubmissionRepository['markVenueAccepted']>().mockResolvedValue(undefined),
    markCommitted: jest.fn<IOrderSubmissionRepository['markCommitted']>().mockResolvedValue(undefined),
    markUnknown: jest.fn<IOrderSubmissionRepository['markUnknown']>().mockResolvedValue(undefined),
    markFailed: jest.fn<IOrderSubmissionRepository['markFailed']>().mockResolvedValue(undefined),
    markCancelled: jest.fn<IOrderSubmissionRepository['markCancelled']>().mockResolvedValue(undefined),
    get: jest.fn<IOrderSubmissionRepository['get']>().mockResolvedValue(undefined),
    findByVenueOrderId: jest.fn<IOrderSubmissionRepository['findByVenueOrderId']>().mockResolvedValue(undefined),
    listByStatus: jest.fn<IOrderSubmissionRepository['listByStatus']>().mockResolvedValue([]),
    getPendingBuyQuantityForInstrument: jest.fn<IOrderSubmissionRepository['getPendingBuyQuantityForInstrument']>()
      .mockResolvedValue(Ok(new Decimal(0))),
    ...overrides,
  };
}

function makeRiskChecker(pass = true): IOrderRiskChecker {
  return {
    checkBeforeOrder: jest.fn<IOrderRiskChecker['checkBeforeOrder']>().mockReturnValue(
      pass
        ? Ok(undefined)
        : Err(new RiskViolationErrorClass('MAX_OPEN_ORDERS_EXCEEDED', 'Too many open orders', {})),
    ),
  };
}

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;
const ASSET_ID = 'token-abc' as unknown as AssetId;
const INSTRUMENT_ID = 'token-abc' as unknown as InstrumentId;
const ORDER_ID = 'order-1' as unknown as OrderId;

function makeInput(overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  return {
    orderId: ORDER_ID,
    accountId: ACCOUNT_ID,
    asset: ASSET_ID,
    instrumentId: INSTRUMENT_ID,
    side: 'BUY',
    price: makePrice('0.65'),
    size: makeQty('100'),
    portfolio: makePortfolio(),
    openOrdersCount: 0,
    strategyId: 'test-strategy',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceOrderUseCase', () => {
  let logger: ILogger;
  let clock: IClock;
  let eventBus: IEventBus;
  let orderRepo: IOrderRepository;
  let portfolioStore: IPortfolioStore;
  let exchangeClient: IExchangeClient;
  let riskChecker: IOrderRiskChecker;
  let keyedMutex: IKeyedMutex;
  let orderedEventOutbox: InMemoryOrderedEventOutbox;
  let submissions: InMemoryOrderSubmissionRepository;
  let deps: PlaceOrderDeps;

  beforeEach(() => {
    logger = makeLogger();
    clock = makeClock();
    eventBus = makeEventBus();
    orderRepo = makeOrderRepo();
    portfolioStore = makePortfolioStore();
    exchangeClient = makeExchangeClient(); // default: 'exchange-order-1' (venueOrderId)
    riskChecker = makeRiskChecker(true);
    keyedMutex = makeKeyedMutex();
    orderedEventOutbox = makeOutbox(eventBus);
    submissions = new InMemoryOrderSubmissionRepository();

    const portfolioService = new PortfolioService(portfolioStore, logger);

    deps = {
      riskChecker,
      orderRepo,
      portfolioService,
      exchangeClient,
      keyedMutex,
      orderStateStore: {
        markOrderFillMatched: jest.fn(),
        hasMatchedFills: jest.fn().mockReturnValue(false),
        getMatchedFillIds: jest.fn().mockReturnValue([]),
        getOpenOrdersByInstrument: jest.fn().mockReturnValue([]),
        hasInFlightFills: jest.fn().mockReturnValue(false),
        markInFlightFill: jest.fn(),
        clearInFlightFill: jest.fn(),
        getInFlightFills: jest.fn().mockReturnValue([]),
        hasUnsettledFills: jest.fn().mockReturnValue(false),
        getFillProcessingBlocks: jest.fn().mockReturnValue([]),
        hasFillProcessingBlocks: jest.fn().mockReturnValue(false),
        markManualReconciliationBlock: jest.fn(),
        clearManualReconciliationBlock: jest.fn(),
        hasManualReconciliationBlockForOrder: jest.fn().mockReturnValue(false),
        hasManualReconciliationBlocks: jest.fn().mockReturnValue(false),
        getManualReconciliationBlocks: jest.fn().mockReturnValue([]),
        markTerminalSettlementPending: jest.fn(),
        clearTerminalSettlementPending: jest.fn(),
        hasTerminalSettlementPendingForOrder: jest.fn().mockReturnValue(false),
        hasTerminalSettlementPending: jest.fn().mockReturnValue(false),
        getTerminalSettlementPending: jest.fn().mockReturnValue([]),
      } as unknown as IOrderStateStore,
      // eventBus больше не dep — публикация через ordered outbox (flush после lock).
      orderedEventOutbox,
      submissions,
      clock,
      logger,
    };
  });

  // ── Успешный сценарий ─────────────────────────────────────────────────────

  it('возвращает Ok(venueOrderId) при успешном размещении', async () => {
    const useCase = new PlaceOrderUseCase(deps);
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    // Возвращается venueOrderId от биржи, а не внутренний ORDER_ID
    if (result.ok) expect(result.value).toBe('exchange-order-1');
  });

  it('вызывает submitOrder на бирже', async () => {
    const useCase = new PlaceOrderUseCase(deps);
    await useCase.execute(makeInput());
    expect(exchangeClient.submitOrder).toHaveBeenCalled();
  });

  it('сохраняет ордер в репозиторий', async () => {
    const useCase = new PlaceOrderUseCase(deps);
    await useCase.execute(makeInput());
    expect(orderRepo.save).toHaveBeenCalled();
  });

  it('публикует события в eventBus', async () => {
    const useCase = new PlaceOrderUseCase(deps);
    await useCase.execute(makeInput());
    expect(eventBus.publishAll).toHaveBeenCalled();
  });

  it('логирует info при успешном размещении', async () => {
    const useCase = new PlaceOrderUseCase(deps);
    await useCase.execute(makeInput());
    expect(logger.info).toHaveBeenCalledWith(
      'Order placed successfully (events enqueued for flush after lock)',
      expect.any(Object),
    );
  });

  // ── Провал риск-проверки ──────────────────────────────────────────────────

  it('возвращает Err если риск-проверка не прошла', async () => {
    riskChecker = makeRiskChecker(false);
    const useCase = new PlaceOrderUseCase({ ...deps, riskChecker });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as RiskViolationError).riskCode).toBe('MAX_OPEN_ORDERS_EXCEEDED');
    }
  });

  it('не вызывает submitOrder если риск-проверка не прошла', async () => {
    riskChecker = makeRiskChecker(false);
    const useCase = new PlaceOrderUseCase({ ...deps, riskChecker });
    await useCase.execute(makeInput());
    expect(exchangeClient.submitOrder).not.toHaveBeenCalled();
  });

  // ── Ошибка биржи ──────────────────────────────────────────────────────────

  it('возвращает Err при ошибке биржи', async () => {
    const failingExchange: IExchangeClient = {
      submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
        Err(new TradingError('Exchange unavailable') as never),
      ),
      cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
      getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
      getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
    };
    const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient: failingExchange });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(false);
  });

  it('не сохраняет ордер при ошибке биржи', async () => {
    const failingExchange: IExchangeClient = {
      submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
        Err(new TradingError('Exchange unavailable') as never),
      ),
      cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
      getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
      getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
    };
    const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient: failingExchange });
    await useCase.execute(makeInput());
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  // ── CAS конфликт при сохранении ордера ───────────────────────────────────

  describe('save version conflict (CAS)', () => {
    let storePortfolio: Portfolio;

    beforeEach(() => {
      storePortfolio = makePortfolio();
      portfolioStore = makePortfolioStore(storePortfolio);
      const portfolioService = new PortfolioService(portfolioStore, logger);
      (orderRepo.save as jest.Mock).mockImplementation(() =>
        Promise.resolve(Err(new VersionConflictError('exchange-order-1', 0, 1))),
      );
      // submissions.get() → undefined: конфликт трактуется как ЧУЖАЯ запись
      // (не наш committed/VENUE_ACCEPTED ордер) → включается безопасный
      // rollback-cancel branch (cancel venue → release только после подтверждения).
      const foreignConflictSubmissions = makeSubmissionsStub();
      deps = { ...deps, portfolioService, orderRepo, submissions: foreignConflictSubmissions };
    });

    it('возвращает Err и НЕ публикует события', async () => {
      const useCase = new PlaceOrderUseCase(deps);
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(TradingError);
        expect(result.error.message).toMatch(/version conflict/i);
      }
      expect(eventBus.publishAll).not.toHaveBeenCalled();
    });

    it('best-effort отменяет venue-ордер и откатывает резервацию', async () => {
      const useCase = new PlaceOrderUseCase(deps);
      await useCase.execute(makeInput());

      expect(exchangeClient.cancelOrder).toHaveBeenCalledWith('exchange-order-1');
      expect(storePortfolio.releaseReservation).toHaveBeenCalled();
    });

    it('логирует manual reconciliation если venue-отмена падает', async () => {
      (exchangeClient.cancelOrder as jest.Mock).mockImplementation(() =>
        Promise.resolve(Err(new TradingError('cancel failed'))),
      );
      const useCase = new PlaceOrderUseCase(deps);
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/manual reconciliation/i),
        expect.any(Object),
      );
    });

    // ── Rollback: обработка CancelOrderResult (без парсинга текста) ────────

    it('rollback cancel Ok({status: CANCELLED}) — без rollback-специфичного error-лога', async () => {
      (exchangeClient.cancelOrder as jest.Mock).mockImplementation(() =>
        Promise.resolve(Ok({ status: 'CANCELLED' })),
      );
      const useCase = new PlaceOrderUseCase(deps);
      await useCase.execute(makeInput());

      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringMatching(/^Rollback cancel/),
        expect.any(Object),
      );
    });

    it('rollback cancel Ok({status: ALREADY_FILLED}) — логирует manual reconciliation/fill expected', async () => {
      (exchangeClient.cancelOrder as jest.Mock).mockImplementation(() =>
        Promise.resolve(Ok({ status: 'ALREADY_FILLED', reason: 'matched' })),
      );
      const useCase = new PlaceOrderUseCase(deps);
      await useCase.execute(makeInput());

      expect(logger.error).toHaveBeenCalledWith(
        'Rollback cancel failed — order already filled on exchange, reservation held, fill expected',
        expect.objectContaining({ venueOrderId: 'exchange-order-1' }),
      );
    });

    it('rollback cancel Ok({status: UNKNOWN_RETRY_NEEDED}) — логирует manual reconciliation required', async () => {
      (exchangeClient.cancelOrder as jest.Mock).mockImplementation(() =>
        Promise.resolve(Ok({ status: 'UNKNOWN_RETRY_NEEDED', reason: 'weird' })),
      );
      const useCase = new PlaceOrderUseCase(deps);
      await useCase.execute(makeInput());

      expect(logger.error).toHaveBeenCalledWith(
        'Rollback cancel outcome unclear — venue order may still be live, reservation held, manual reconciliation required',
        expect.objectContaining({ venueOrderId: 'exchange-order-1' }),
      );
    });

    it('rollback cancel Err(ExchangeError) — логируется как раньше', async () => {
      (exchangeClient.cancelOrder as jest.Mock).mockImplementation(() =>
        Promise.resolve(Err(new TradingError('exchange unreachable'))),
      );
      const useCase = new PlaceOrderUseCase(deps);
      await useCase.execute(makeInput());

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/manual reconciliation/i),
        expect.objectContaining({ venueOrderId: 'exchange-order-1', error: 'exchange unreachable' }),
      );
    });
  });

  // ── effectiveSize (адаптер скорректировал size перед отправкой) ────────────

  describe('effectiveSize != requested size', () => {
    it('BUY: создаёт Order с effectiveSize и освобождает излишек USDC-резервации', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const exchangeWithAdjustedSize: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'OPEN', orderId: 'exchange-order-1' as unknown as OrderId, effectiveSize: makeQty('80'), remainingSize: makeQty('80') }),
        ),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };

      const useCase = new PlaceOrderUseCase({
        ...deps,
        portfolioService,
        exchangeClient: exchangeWithAdjustedSize,
      });
      // Запрошенный size=100, биржа исполнит только 80 → excess=20 * price(0.65)=13
      await useCase.execute(makeInput({ size: makeQty('100'), price: makePrice('0.65') }));

      expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
      const releaseCall = (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mock.calls[0]?.[0];
      expect((releaseCall as { value(): Decimal }).value().toString()).toBe('13');

      const savedOrder = (orderRepo.save as ReturnType<typeof jest.fn>).mock.calls[0]?.[0];
      expect(savedOrder.size.value().toString()).toBe('80');
    });

    it('SELL: создаёт Order с effectiveSize и освобождает излишек токен-резервации', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const exchangeWithAdjustedSize: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'OPEN', orderId: 'exchange-order-1' as unknown as OrderId, effectiveSize: makeQty('37'), remainingSize: makeQty('37') }),
        ),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };

      const useCase = new PlaceOrderUseCase({
        ...deps,
        portfolioService,
        exchangeClient: exchangeWithAdjustedSize,
      });
      // Запрошенный size=50 (SELL), биржа приняла только 37 (dust-adjust) → excess=13 токенов
      await useCase.execute(makeInput({ side: 'SELL', size: makeQty('50') }));

      expect(portfolio.releaseTokenReservation).toHaveBeenCalled();
      const releaseArgs = (portfolio.releaseTokenReservation as ReturnType<typeof jest.fn>).mock.calls[0];
      expect((releaseArgs?.[1] as Decimal).toString()).toBe('13');

      const savedOrder = (orderRepo.save as ReturnType<typeof jest.fn>).mock.calls[0]?.[0];
      expect(savedOrder.size.value().toString()).toBe('37');
    });

    it('не освобождает излишек и не логирует adjustment, если effectiveSize == requested size', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService });

      await useCase.execute(makeInput({ size: makeQty('100') }));

      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith(
        'Exchange adjusted order size — releasing excess reservation',
        expect.anything(),
      );
    });

    it('возвращает Err и отменяет venue-ордер, если effectiveSize == 0', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const cancelOrder = jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' }));
      const exchangeWithZeroSize: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'OPEN', orderId: 'exchange-order-1' as unknown as OrderId, effectiveSize: makeQty('0'), remainingSize: makeQty('0') }),
        ),
        cancelOrder,
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };

      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient: exchangeWithZeroSize });
      const result = await useCase.execute(makeInput({ size: makeQty('100') }));

      expect(result.ok).toBe(false);
      expect(cancelOrder).toHaveBeenCalledWith('exchange-order-1');
      expect(orderRepo.save).not.toHaveBeenCalled();
      // Освобождается ПОЛНАЯ исходная резервация (не частичная) — adapter вернул мусор,
      // доверять effectiveSize нельзя вообще.
      expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
    });

    it('возвращает Err и отменяет venue-ордер, если effectiveSize > requested size', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const cancelOrder = jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' }));
      const exchangeWithOversizedFill: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'OPEN', orderId: 'exchange-order-1' as unknown as OrderId, effectiveSize: makeQty('150'), remainingSize: makeQty('150') }),
        ),
        cancelOrder,
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };

      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient: exchangeWithOversizedFill });
      const result = await useCase.execute(makeInput({ size: makeQty('100') }));

      expect(result.ok).toBe(false);
      expect(cancelOrder).toHaveBeenCalledWith('exchange-order-1');
      expect(orderRepo.save).not.toHaveBeenCalled();
    });

    it('возвращает Err и отменяет venue-ордер, если освобождение излишка резервации падает', async () => {
      const portfolio = makePortfolio();
      (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('store unavailable') as never),
      );
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const cancelOrder = jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' }));
      const exchangeWithAdjustedSize: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'OPEN', orderId: 'exchange-order-1' as unknown as OrderId, effectiveSize: makeQty('80'), remainingSize: makeQty('80') }),
        ),
        cancelOrder,
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };

      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient: exchangeWithAdjustedSize });
      const result = await useCase.execute(makeInput({ size: makeQty('100') }));

      expect(result.ok).toBe(false);
      expect(cancelOrder).toHaveBeenCalledWith('exchange-order-1');
      expect(orderRepo.save).not.toHaveBeenCalled();
    });

    it('логирует error, если cancelOrder падает после invalid effectiveSize (manual reconciliation)', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const cancelOrder = jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(
        Err(new TradingError('exchange unreachable') as never),
      );
      const exchangeWithZeroSize: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'OPEN', orderId: 'exchange-order-1' as unknown as OrderId, effectiveSize: makeQty('0'), remainingSize: makeQty('0') }),
        ),
        cancelOrder,
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };

      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient: exchangeWithZeroSize });
      const result = await useCase.execute(makeInput({ size: makeQty('100') }));

      expect(result.ok).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to cancel exchange order after invalid effectiveSize — venue order may still be live, manual reconciliation required',
        expect.objectContaining({ venueOrderId: 'exchange-order-1' }),
      );
    });

    it('логирует error, если cancelOrder падает после excess-release failure (manual reconciliation)', async () => {
      const portfolio = makePortfolio();
      (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('store unavailable') as never),
      );
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const cancelOrder = jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(
        Err(new TradingError('exchange unreachable') as never),
      );
      const exchangeWithAdjustedSize: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'OPEN', orderId: 'exchange-order-1' as unknown as OrderId, effectiveSize: makeQty('80'), remainingSize: makeQty('80') }),
        ),
        cancelOrder,
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };

      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient: exchangeWithAdjustedSize });
      const result = await useCase.execute(makeInput({ size: makeQty('100') }));

      expect(result.ok).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to cancel exchange order after excess-release failure — venue order may still be live, manual reconciliation required',
        expect.objectContaining({ venueOrderId: 'exchange-order-1' }),
      );
    });
  });

  // ── Post-commit publish failure (notification path, не транзакция) ─────────

  it('сбой publishAll (flush после lock) ПОСЛЕ успешного save — Ok(venueOrderId), не Err (committed operation не retryable)', async () => {
    // Сбой публикации теперь проглатывается outbox на flush() (ПОСЛЕ lock):
    // outbox логирует EVENT_PUBLISH_FAILED и создаёт issue, а PlaceOrderUseCase
    // возвращает Ok — commit (save+markers) уже выполнен под lock.
    const failingBus: IEventBus = {
      ...eventBus,
      publishAll: jest.fn<IEventBus['publishAll']>().mockRejectedValue(new Error('bus down')),
    };
    const outboxLogger = makeLogger();
    const reconciliationIssues = makeReconciliationIssueRepo();
    const failingOutbox = new InMemoryOrderedEventOutbox({
      publish: (events) => failingBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]),
      logger: outboxLogger,
      reconciliationIssues,
    });
    const useCase = new PlaceOrderUseCase({ ...deps, orderedEventOutbox: failingOutbox });

    const result = await useCase.execute(makeInput());

    // Ордер уже сохранён и live на venue — Err сделал бы операцию retryable
    // и повторный вызов создал бы дублирующий ордер.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('exchange-order-1');
    expect(orderRepo.save).toHaveBeenCalled();
    expect(failingBus.publishAll).toHaveBeenCalled();
    // Outbox залогировал EVENT_PUBLISH_FAILED и создал issue.
    expect(outboxLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('EVENT_PUBLISH_FAILED'),
      expect.objectContaining({ aggregateId: 'exchange-order-1' }),
    );
    const addCalls = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls;
    expect(addCalls).toHaveLength(1);
    expect((addCalls[0]?.[0] as { type: string }).type).toBe('EVENT_PUBLISH_FAILED');
  });

  // ── Keyed mutex: сериализация reserve+submit+save ───────────────────────────

  describe('keyed mutex', () => {
    it('runExclusive вызывается с ключами accountId + instrumentId; submit и save — внутри lock', async () => {
      const callOrder: string[] = [];
      const trackingMutex: IKeyedMutex = {
        runExclusive: jest.fn(async <T>(_keys: readonly string[], fn: () => Promise<T>) => {
          callOrder.push('lock-enter');
          const result = await fn();
          callOrder.push('lock-exit');
          return result;
        }) as unknown as IKeyedMutex['runExclusive'],
      };
      const trackingExchange: IExchangeClient = {
        ...makeExchangeClient(),
        submitOrder: jest.fn(async () => {
          callOrder.push('submit');
          return Ok({
            status: 'OPEN' as const,
            orderId: 'exchange-order-1' as unknown as OrderId,
            effectiveSize: makeQty('100'),
            remainingSize: makeQty('100'),
          });
        }) as unknown as IExchangeClient['submitOrder'],
      };
      const trackingRepo: IOrderRepository = {
        ...makeOrderRepo(),
        save: jest.fn(async () => {
          callOrder.push('save');
          return Ok(undefined);
        }) as unknown as IOrderRepository['save'],
      };
      const useCase = new PlaceOrderUseCase({
        ...deps,
        keyedMutex: trackingMutex,
        exchangeClient: trackingExchange,
        orderRepo: trackingRepo,
      });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      const keys = (trackingMutex.runExclusive as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as string[];
      // Namespaced ключи: `instrument:<id>` и `account:<accountIdToString>`.
      expect(keys).toContain(`instrument:${String(INSTRUMENT_ID)}`);
      // account-ключ обязан совпадать с ключом ProcessFillUseCase/CancelOrderUseCase
      // (оба namespace-ят через accountIdToString) — иначе lock-наборы не пересекутся.
      expect(keys).toContain(`account:${accountIdToString(ACCOUNT_ID)}`);
      // Весь критический участок — внутри lock.
      expect(callOrder).toEqual(['lock-enter', 'submit', 'save', 'lock-exit']);
    });

    it('risk-check failure → lock не берётся, submit не вызывается', async () => {
      const useCase = new PlaceOrderUseCase({ ...deps, riskChecker: makeRiskChecker(false) });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(keyedMutex.runExclusive).not.toHaveBeenCalled();
      expect(exchangeClient.submitOrder).not.toHaveBeenCalled();
    });

    it('reserve failure (внутри lock) → submit не вызывается', async () => {
      const failingPortfolio = makePortfolio();
      (failingPortfolio.reserveForOrder as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('insufficient available balance')),
      );
      const store = makePortfolioStore(failingPortfolio);
      const portfolioService = new PortfolioService(store, logger);
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(keyedMutex.runExclusive).toHaveBeenCalled(); // lock взят
      expect(exchangeClient.submitOrder).not.toHaveBeenCalled(); // но до submit не дошло
    });
  });

  // ── Rollback cancel outcomes → reconciliation issues ────────────────────────

  describe('rollback cancel issues', () => {
    /** Exchange: submit OK (OPEN), save конфликтует → rollback cancel с заданным исходом */
    function makeSaveConflictSetup(
      cancelResult: Awaited<ReturnType<IExchangeClient['cancelOrder']>>,
    ): {
      exchangeClient: IExchangeClient;
      orderRepo: IOrderRepository;
      reconciliationIssues: IReconciliationIssueRepository;
      submissions: IOrderSubmissionRepository;
    } {
      return {
        exchangeClient: {
          ...makeExchangeClient(),
          cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(cancelResult),
        },
        orderRepo: {
          ...makeOrderRepo(),
          save: jest.fn<IOrderRepository['save']>().mockResolvedValue(
            Err(new VersionConflictError('exchange-order-1', 0, 1)),
          ),
        },
        reconciliationIssues: makeReconciliationIssueRepo(),
        // submissions.get() → undefined: конфликт трактуется как ЧУЖАЯ запись
        // (не наш committed/VENUE_ACCEPTED ордер), поэтому включается безопасный
        // rollback-cancel branch (а не idempotent no-cancel).
        submissions: makeSubmissionsStub(),
      };
    }

    it('save conflict + rollback cancel ALREADY_FILLED → VENUE_LOCAL_ORDER_DESYNC issue, исходный Err сохранён', async () => {
      const setup = makeSaveConflictSetup(Ok({ status: 'ALREADY_FILLED', reason: 'order is matched' } as CancelOrderResult));
      const useCase = new PlaceOrderUseCase({ ...deps, ...setup });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/version conflict/i);
      expect(setup.reconciliationIssues.add).toHaveBeenCalledTimes(1);
      const issue = (setup.reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        type: string;
        reason: string;
        orderId: unknown;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe('reconciliation:place-rollback:exchange-order-1:already-filled');
      expect(issue.type).toBe('VENUE_LOCAL_ORDER_DESYNC');
      expect(issue.reason).toBe('ROLLBACK_CANCEL_ALREADY_FILLED: order is matched');
      expect(issue.orderId).toBe('exchange-order-1');
      expect(issue.context).toMatchObject({
        stage: 'save-conflict-rollback',
        clientOrderId: String(ORDER_ID),
        rollbackCancelOutcome: 'ALREADY_FILLED',
        localOrderSaved: false,
      });
    });

    it('invalid effectiveSize + rollback cancel UNKNOWN_RETRY_NEEDED → CANCEL_UNKNOWN_OUTCOME issue', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      const exchangeClient: IExchangeClient = {
        ...makeExchangeClient(),
        // effectiveSize > input.size — нарушение контракта порта → rollback.
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({
            status: 'OPEN',
            orderId: 'exchange-order-1' as unknown as OrderId,
            effectiveSize: makeQty('150'),
            remainingSize: makeQty('150'),
          }),
        ),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(
          Ok({ status: 'UNKNOWN_RETRY_NEEDED', reason: 'timeout' } as CancelOrderResult),
        ),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(reconciliationIssues.add).toHaveBeenCalledTimes(1);
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        type: string;
        reason: string;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe('reconciliation:place-rollback:exchange-order-1:unknown');
      expect(issue.type).toBe('CANCEL_UNKNOWN_OUTCOME');
      expect(issue.reason).toBe('ROLLBACK_CANCEL_UNKNOWN_OUTCOME: timeout');
      expect(issue.context).toMatchObject({
        stage: 'invalid-effective-size-rollback',
        rollbackCancelOutcome: 'UNKNOWN_RETRY_NEEDED',
      });
    });

    it('rollback cancel транспортный Err → CANCEL_UNKNOWN_OUTCOME issue transport-error', async () => {
      const setup = makeSaveConflictSetup(Err(new TradingError('network down') as never));
      const useCase = new PlaceOrderUseCase({ ...deps, ...setup });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(setup.reconciliationIssues.add).toHaveBeenCalledTimes(1);
      const issue = (setup.reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        type: string;
        reason: string;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe('reconciliation:place-rollback:exchange-order-1:transport-error');
      expect(issue.type).toBe('CANCEL_UNKNOWN_OUTCOME');
      expect(issue.reason).toBe('ROLLBACK_CANCEL_TRANSPORT_ERROR: network down');
      expect(issue.context).toMatchObject({ rollbackCancelOutcome: 'TRANSPORT_ERROR' });
    });

    it('rollback cancel CANCELLED (чистый rollback) — issue НЕ создаётся', async () => {
      const setup = makeSaveConflictSetup(Ok({ status: 'CANCELLED' } as CancelOrderResult));
      const useCase = new PlaceOrderUseCase({ ...deps, ...setup });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(setup.reconciliationIssues.add).not.toHaveBeenCalled();
    });

    it('сбой issue store не маскирует исходный Err rollback-ветки', async () => {
      const setup = makeSaveConflictSetup(Ok({ status: 'ALREADY_FILLED', reason: 'matched' } as CancelOrderResult));
      (setup.reconciliationIssues.add as ReturnType<typeof jest.fn>).mockImplementation(() =>
        Promise.reject(new Error('issue store down')),
      );
      const useCase = new PlaceOrderUseCase({ ...deps, ...setup });

      const result = await useCase.execute(makeInput());

      // Err про version conflict, а не про issue store.
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/version conflict/i);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to add reconciliation issue',
        expect.objectContaining({ issueType: 'VENUE_LOCAL_ORDER_DESYNC' }),
      );
    });
  });

  // ── Rollback RELEASE failure → ORDER_PORTFOLIO_DESYNC issue ──────────────────

  describe('rollback release failure issues', () => {
    it('REJECTED submit + сбой release → ORDER_PORTFOLIO_DESYNC issue (client-id, без venueOrderId)', async () => {
      const portfolio = makePortfolio();
      (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('cannot unfreeze')),
      );
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const exchangeClient: IExchangeClient = {
        ...makeExchangeClient(),
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'REJECTED', reason: 'FOK could not fill' }),
        ),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      // Ровно одна issue — release-failed (REJECTED сам issue не создаёт).
      expect(reconciliationIssues.add).toHaveBeenCalledTimes(1);
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        type: string;
        reason: string;
        orderId?: unknown;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe(`reconciliation:place-rollback-client:${String(ORDER_ID)}:release-failed`);
      expect(issue.type).toBe('ORDER_PORTFOLIO_DESYNC');
      expect(issue.reason).toContain('PLACE_ROLLBACK_RELEASE_FAILED');
      expect(issue.reason).toContain('cannot unfreeze');
      expect(issue.orderId).toBeUndefined(); // REJECTED не создаёт venue order
      expect(issue.context).toMatchObject({
        stage: 'rejected-submit-rollback',
        clientOrderId: String(ORDER_ID),
      });
    });

    it('save conflict + сбой release → ORDER_PORTFOLIO_DESYNC issue с venueOrderId', async () => {
      const portfolio = makePortfolio();
      (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('cannot unfreeze after save conflict')),
      );
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const orderRepo: IOrderRepository = {
        ...makeOrderRepo(),
        save: jest.fn<IOrderRepository['save']>().mockResolvedValue(
          Err(new VersionConflictError('exchange-order-1', 0, 1)),
        ),
      };
      // submissions.get() → undefined → foreign-conflict rollback branch (cancel + release).
      const submissions = makeSubmissionsStub();
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, orderRepo, reconciliationIssues, submissions });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      // Две issues: rollback cancel (CANCELLED → нет) + release-failed. cancel
      // по умолчанию CANCELLED → issue не создаёт, значит ровно одна — release.
      const calls = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls;
      const releaseIssue = calls
        .map((c) => c[0] as { id: string; type: string; orderId?: unknown; context?: Record<string, unknown> })
        .find((i) => i.id.endsWith(':release-failed'));
      expect(releaseIssue).toBeDefined();
      expect(releaseIssue!.id).toBe('reconciliation:place-rollback:exchange-order-1:release-failed');
      expect(releaseIssue!.type).toBe('ORDER_PORTFOLIO_DESYNC');
      expect(releaseIssue!.orderId).toBe('exchange-order-1');
      expect(releaseIssue!.context).toMatchObject({
        stage: 'save-conflict-rollback',
        venueOrderId: 'exchange-order-1',
      });
    });

    it('успешный release → release-failed issue НЕ создаётся', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      const exchangeClient: IExchangeClient = {
        ...makeExchangeClient(),
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'REJECTED', reason: 'FOK could not fill' }),
        ),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      const releaseIssue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { id: string })
        .find((i) => i.id.endsWith(':release-failed'));
      expect(releaseIssue).toBeUndefined();
    });
  });

  // ── Authoritative risk-check под lock (свежее состояние) ─────────────────────

  describe('authoritative risk-check под lock', () => {
    it('precheck проходит на stale snapshot, но authoritative check под lock падает на свежем count → Err, submit НЕ вызывается', async () => {
      // Свежий openOrdersCount из репозитория превышает лимит, хотя input.openOrdersCount = 0.
      const orderRepo: IOrderRepository = {
        ...makeOrderRepo(),
        countByStrategyId: jest.fn<IOrderRepository['countByStrategyId']>().mockResolvedValue(99),
      };
      // checkBeforeOrder: 1-й вызов (precheck) — Ok, 2-й (authoritative) — Err.
      const riskChecker: IOrderRiskChecker = {
        checkBeforeOrder: jest.fn<IOrderRiskChecker['checkBeforeOrder']>()
          .mockReturnValueOnce(Ok(undefined))
          .mockReturnValueOnce(
            Err(new RiskViolationErrorClass('MAX_OPEN_ORDERS_EXCEEDED', 'Too many open orders', {})),
          ),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, orderRepo, riskChecker });

      const result = await useCase.execute(makeInput({ openOrdersCount: 0 }));

      expect(result.ok).toBe(false);
      // authoritative check прочитал свежий count из репозитория…
      expect(orderRepo.countByStrategyId).toHaveBeenCalled();
      // …и до submit дело не дошло — лимит превышен на свежем состоянии.
      expect(exchangeClient.submitOrder).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('authoritative'),
        expect.objectContaining({ freshOpenOrdersCount: 99 }),
      );
    });

    it('authoritative check выполняется ВНУТРИ lock (submit не вызывается при провале)', async () => {
      const callOrder: string[] = [];
      const trackingMutex: IKeyedMutex = {
        runExclusive: jest.fn(async <T>(_keys: readonly string[], fn: () => Promise<T>) => {
          callOrder.push('lock-enter');
          const r = await fn();
          callOrder.push('lock-exit');
          return r;
        }) as unknown as IKeyedMutex['runExclusive'],
      };
      const riskChecker: IOrderRiskChecker = {
        checkBeforeOrder: jest.fn<IOrderRiskChecker['checkBeforeOrder']>()
          .mockReturnValueOnce(Ok(undefined)) // precheck
          .mockImplementationOnce(() => {
            callOrder.push('authoritative-check');
            return Err(new RiskViolationErrorClass('MAX_OPEN_ORDERS_EXCEEDED', 'too many', {}));
          }),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, keyedMutex: trackingMutex, riskChecker });

      await useCase.execute(makeInput());

      // authoritative check между lock-enter и lock-exit.
      expect(callOrder).toEqual(['lock-enter', 'authoritative-check', 'lock-exit']);
    });
  });

  // ── publishAll (flush) ВНЕ lock, enqueue внутри lock ─────────────────────────

  describe('flush после lock (per-order event ordering)', () => {
    it('события enqueue-ятся ВНУТРИ lock, а publishAll (flush) — строго ПОСЛЕ lock-exit', async () => {
      const callOrder: string[] = [];
      const trackingMutex: IKeyedMutex = {
        runExclusive: jest.fn(async <T>(_keys: readonly string[], fn: () => Promise<T>) => {
          callOrder.push('lock-enter');
          const r = await fn();
          callOrder.push('lock-exit');
          return r;
        }) as unknown as IKeyedMutex['runExclusive'],
      };
      // publishAll теперь вызывается outbox'ом на flush() ПОСЛЕ выхода из lock.
      const eventBusSpy: IEventBus = {
        publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
        publishAll: jest.fn(async () => { callOrder.push('publishAll'); }) as unknown as IEventBus['publishAll'],
        subscribe: jest.fn<IEventBus['subscribe']>().mockReturnValue(() => {}),
      };
      const useCase = new PlaceOrderUseCase({
        ...deps,
        keyedMutex: trackingMutex,
        orderedEventOutbox: makeOutbox(eventBusSpy),
      });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      // publishAll — строго ПОСЛЕ lock-exit (enqueue под lock, flush вне lock).
      // Это исключает deadlock (handler → lock-зависимый use-case), а per-order
      // FIFO сохраняется внутри outbox по aggregateId.
      expect(callOrder).toEqual(['lock-enter', 'lock-exit', 'publishAll']);
    });

    it('сбой publishAll (flush после lock) после commit → Ok(venueOrderId), EVENT_PUBLISH_FAILED issue (создаёт outbox)', async () => {
      const failingBus: IEventBus = {
        ...eventBus,
        publishAll: jest.fn<IEventBus['publishAll']>().mockRejectedValue(new Error('bus down')),
      };
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new PlaceOrderUseCase({
        ...deps,
        orderedEventOutbox: makeOutbox(failingBus, reconciliationIssues),
      });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('exchange-order-1');
      expect(orderRepo.save).toHaveBeenCalled();
      // Queryable issue для ручного replay — создаётся outbox'ом на flush.
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { id: string; type: string })
        .find((i) => i.type === 'EVENT_PUBLISH_FAILED');
      expect(issue).toBeDefined();
      expect(issue!.id).toBe('reconciliation:outbox:exchange-order-1:event-publish-failed');
    });
  });

  // ── Ambiguous submit transport error (ExchangeError.submitOutcome) ──────────

  describe('submit transport error ambiguity', () => {
    function makeErrExchange(error: ExchangeError): IExchangeClient {
      return {
        ...makeExchangeClient(),
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(Err(error)),
      };
    }

    it('MAY_HAVE_BEEN_SUBMITTED → SUBMIT_UNKNOWN_OUTCOME issue, резервация УДЕРЖАНА (не release), Err, Order НЕ создаётся', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const exchangeClient = makeErrExchange(
        new ExchangeError('network timeout', { submitOutcome: 'MAY_HAVE_BEEN_SUBMITTED' }),
      );
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(orderRepo.save).not.toHaveBeenCalled();
      // Ордер МОГ создаться на venue — освобождать резервацию нельзя (двойной
      // debit при последующем fill). Резервация удержана до reconciliation.
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { id: string; type: string; context?: Record<string, unknown> })
        .find((i) => i.type === 'SUBMIT_UNKNOWN_OUTCOME');
      expect(issue).toBeDefined();
      expect(issue!.id).toBe(`reconciliation:submit-client:${String(ORDER_ID)}:unknown`);
      expect(issue!.context).toMatchObject({
        submitOutcome: 'MAY_HAVE_BEEN_SUBMITTED',
        cancelAttempted: false,
        reservationHeld: true,
      });
    });

    it('DEFINITELY_NOT_SUBMITTED → чистый rollback + Err, SUBMIT_UNKNOWN_OUTCOME issue НЕ создаётся', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const exchangeClient = makeErrExchange(
        new ExchangeError('preflight rejected', { submitOutcome: 'DEFINITELY_NOT_SUBMITTED' }),
      );
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(orderRepo.save).not.toHaveBeenCalled();
      expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
      const unknownIssue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { type: string })
        .find((i) => i.type === 'SUBMIT_UNKNOWN_OUTCOME');
      expect(unknownIssue).toBeUndefined();
    });

    it('legacy ExchangeError без submitOutcome → conservative default MAY_HAVE_BEEN_SUBMITTED (issue создаётся)', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      // Bare error без поля submitOutcome (legacy adapter).
      const exchangeClient = makeErrExchange(new ExchangeError('connectivity error'));
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { type: string })
        .find((i) => i.type === 'SUBMIT_UNKNOWN_OUTCOME');
      expect(issue).toBeDefined();
    });
  });

  // ── Submission guard по clientOrderId (IOrderSubmissionRepository) ───────────

  describe('submission guard (clientOrderId)', () => {
    it('повторный execute() после committed submit возвращает существующий venueOrderId, НЕ submit/cancel', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      const exchangeClient = makeExchangeClient();
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient, submissions });

      // Первый вызов — успешно committed.
      const first = await useCase.execute(makeInput());
      expect(first.ok).toBe(true);
      const submitCallsAfterFirst = (exchangeClient.submitOrder as ReturnType<typeof jest.fn>).mock.calls.length;

      // Второй вызов с тем же clientOrderId (ORDER_ID) — короткое замыкание.
      const second = await useCase.execute(makeInput());

      expect(second.ok).toBe(true);
      if (second.ok) expect(second.value).toBe('exchange-order-1');
      // submitOrder НЕ вызван повторно, cancelOrder не вызван вообще.
      expect((exchangeClient.submitOrder as ReturnType<typeof jest.fn>).mock.calls.length).toBe(submitCallsAfterFirst);
      expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
    });

    it('save conflict с уже committed submission (тот же venueOrderId) НЕ отменяет venue-ордер', async () => {
      // Эмулируем гонку: begin() вернул ACQUIRED, но к моменту save-conflict
      // submissions.get() уже показывает COMMITTED под тем же venueOrderId
      // (наш собственный предыдущий committed submit). Стаб с begin→ACQUIRED,
      // get→COMMITTED.
      const racySubmissions = makeSubmissionsStub({
        get: jest.fn<IOrderSubmissionRepository['get']>().mockResolvedValue(makeSubmissionRecord({
          venueOrderId: 'exchange-order-1' as unknown as OrderId,
          status: 'COMMITTED',
        })),
      });

      const conflictingRepo: IOrderRepository = {
        ...makeOrderRepo(),
        save: jest.fn<IOrderRepository['save']>().mockResolvedValue(
          Err(new VersionConflictError('exchange-order-1', 0, 1)),
        ),
        // Наш прошлый committed submit уже сохранил Order под этим venueOrderId:
        // save-conflict branch находит его через get() → idempotent success, без cancel.
        get: jest.fn().mockImplementation(() =>
          Promise.resolve({ id: 'exchange-order-1' } as unknown),
        ) as unknown as IOrderRepository['get'],
      };
      const exchangeClient = makeExchangeClient();
      const useCase = new PlaceOrderUseCase({ ...deps, orderRepo: conflictingRepo, exchangeClient, submissions: racySubmissions });

      const result = await useCase.execute(makeInput());

      // Конфликт совпал с нашим committed submission → Ok(venueOrderId), без cancel.
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('exchange-order-1');
      expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
    });

    // ── Stage 5: corrupt submission без venueOrderId ─────────────────────────
    for (const [outcome, recordStatus] of [
      ['ALREADY_COMMITTED', 'COMMITTED'],
      ['VENUE_ACCEPTED', 'VENUE_ACCEPTED'],
    ] as const) {
      it(`${outcome} БЕЗ venueOrderId → Err, issue, НЕ reserve/submit/cancel/markFailed`, async () => {
        const reconciliationIssues = makeReconciliationIssueRepo();
        // begin() возвращает corrupt outcome без venueOrderId.
        const corruptSubmissions = makeSubmissionsStub({
          begin: jest.fn<IOrderSubmissionRepository['begin']>().mockResolvedValue({
            outcome,
            record: makeSubmissionRecord({ status: recordStatus, venueOrderId: undefined }),
          }),
        });
        const portfolio = makePortfolio();
        const store = makePortfolioStore(portfolio);
        const portfolioService = new PortfolioService(store, logger);
        const exchangeClient = makeExchangeClient();
        const useCase = new PlaceOrderUseCase({
          ...deps, portfolioService, exchangeClient, submissions: corruptSubmissions, reconciliationIssues,
        });

        const result = await useCase.execute(makeInput());

        expect(result.ok).toBe(false);
        // Никаких мутаций venue/portfolio.
        expect(portfolio.reserveForOrder).not.toHaveBeenCalled();
        expect(portfolio.reserveTokensForOrder).not.toHaveBeenCalled();
        expect(exchangeClient.submitOrder).not.toHaveBeenCalled();
        expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
        expect(corruptSubmissions.markFailed).not.toHaveBeenCalled();
        // Детерминированный issue.
        const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
          .map((c) => c[0] as { id: string; type: string; context?: Record<string, unknown> })
          .find((i) => i.id.endsWith(':corrupt-submission-missing-venue-order-id'));
        expect(issue).toBeDefined();
        expect(issue!.type).toBe('VENUE_LOCAL_ORDER_DESYNC');
        expect(issue!.context).toMatchObject({ stage: 'corrupt-submission-missing-venue-order-id', submissionStatus: recordStatus });
      });
    }

    it('UNKNOWN submit помечает submission UNKNOWN → повторный execute() блокирован (Err, issue)', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      const reconciliationIssues = makeReconciliationIssueRepo();
      const exchangeClient: IExchangeClient = {
        ...makeExchangeClient(),
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'UNKNOWN', reason: 'ambiguous venue reply' }),
        ),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient, submissions, reconciliationIssues });

      const first = await useCase.execute(makeInput());
      expect(first.ok).toBe(false);
      const submitCalls = (exchangeClient.submitOrder as ReturnType<typeof jest.fn>).mock.calls.length;

      // Повторный execute — begin() видит UNKNOWN → блок, submit НЕ повторяется.
      const second = await useCase.execute(makeInput());
      expect(second.ok).toBe(false);
      expect((exchangeClient.submitOrder as ReturnType<typeof jest.fn>).mock.calls.length).toBe(submitCalls);
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { type: string; reason: string })
        .find((i) => i.reason.includes('PRIOR_SUBMISSION_UNKNOWN'));
      expect(issue).toBeDefined();
    });

    it('DEFINITELY_NOT_SUBMITTED помечает FAILED → повторный execute() РАЗРЕШён (submit вызывается снова)', async () => {
      const submissions = new InMemoryOrderSubmissionRepository();
      const failingThenOk: IExchangeClient = {
        ...makeExchangeClient(),
        submitOrder: jest.fn<IExchangeClient['submitOrder']>()
          .mockResolvedValueOnce(Err(new ExchangeError('preflight', { submitOutcome: 'DEFINITELY_NOT_SUBMITTED' })))
          .mockResolvedValue(Ok({ status: 'OPEN', orderId: 'exchange-order-1' as unknown as OrderId, effectiveSize: makeQty('100'), remainingSize: makeQty('100') })),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient: failingThenOk, submissions });

      const first = await useCase.execute(makeInput());
      expect(first.ok).toBe(false);

      // Retry разрешён — FAILED_RETRYABLE → submit вызывается снова, успех.
      const second = await useCase.execute(makeInput());
      expect(second.ok).toBe(true);
      expect((failingThenOk.submitOrder as ReturnType<typeof jest.fn>).mock.calls.length).toBe(2);
    });

    it('первый execute() с чистым submissions guard проходит (ACQUIRED → COMMITTED)', async () => {
      // submissions теперь ОБЯЗАТЕЛЬНЫЙ dep (в beforeEach — чистый InMemory guard).
      const useCase = new PlaceOrderUseCase(deps);
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(true);
      // После успеха submission помечен COMMITTED под venueOrderId.
      const record = await submissions.get(ORDER_ID);
      expect(record?.status).toBe('COMMITTED');
      expect(record?.venueOrderId).toBe('exchange-order-1');
    });
  });

  // ── SubmitOrderResult.status (OPEN/PARTIALLY_FILLED/FILLED/REJECTED/UNKNOWN) ──

  describe('submitOrder status handling', () => {
    it('OPEN: сохраняет ордер, не помечает matched', async () => {
      const useCase = new PlaceOrderUseCase(deps);
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(orderRepo.save).toHaveBeenCalled();
      expect(deps.orderStateStore.markOrderFillMatched).not.toHaveBeenCalled();
    });

    it('PARTIALLY_FILLED: сохраняет ордер, помечает pending matched', async () => {
      const exchangeClient: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({
            status: 'PARTIALLY_FILLED',
            orderId: 'exchange-order-1' as unknown as OrderId,
            effectiveSize: makeQty('100'),
            filledSize: makeQty('40'),
            remainingSize: makeQty('60'),
          }),
        ),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(orderRepo.save).toHaveBeenCalled();
      expect(deps.orderStateStore.markOrderFillMatched).toHaveBeenCalledWith(
        'exchange-order-1',
        expect.anything(),
      );
    });

    it('PARTIALLY_FILLED/FILLED: markOrderFillMatched вызывается ДО publishAll — стратегия не должна увидеть ORDER_ACCEPTED раньше marker\'а', async () => {
      const callOrder: string[] = [];
      const orderStateStore = {
        ...(deps.orderStateStore as unknown as Record<string, unknown>),
        markOrderFillMatched: jest.fn(() => { callOrder.push('markOrderFillMatched'); }),
      } as unknown as IOrderStateStore;
      const eventBusSpy: IEventBus = {
        publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
        publishAll: jest.fn(async () => { callOrder.push('publishAll'); }) as unknown as IEventBus['publishAll'],
        subscribe: jest.fn<IEventBus['subscribe']>().mockReturnValue(() => {}),
      };
      const exchangeClient: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({
            status: 'FILLED',
            orderId: 'exchange-order-1' as unknown as OrderId,
            effectiveSize: makeQty('100'),
            filledSize: makeQty('100'),
          }),
        ),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };
      const useCase = new PlaceOrderUseCase({
        ...deps,
        orderStateStore,
        orderedEventOutbox: makeOutbox(eventBusSpy),
        exchangeClient,
      });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      // markOrderFillMatched — под lock (commit), publishAll — на flush после lock.
      // Порядок сохраняется: marker строго ДО публикации.
      expect(callOrder).toEqual(['markOrderFillMatched', 'publishAll']);
    });

    it('FILLED: сохраняет ордер, помечает pending matched, не синтезирует Fill', async () => {
      const exchangeClient: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({
            status: 'FILLED',
            orderId: 'exchange-order-1' as unknown as OrderId,
            effectiveSize: makeQty('100'),
            filledSize: makeQty('100'),
          }),
        ),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(orderRepo.save).toHaveBeenCalled();
      expect(deps.orderStateStore.markOrderFillMatched).toHaveBeenCalledWith(
        'exchange-order-1',
        expect.anything(),
      );
      // Use case не синтезирует Fill и не трогает Portfolio напрямую здесь —
      // сохранённый Order не содержит fill-данных сверх size.
      const savedOrder = (orderRepo.save as ReturnType<typeof jest.fn>).mock.calls[0]?.[0];
      expect(savedOrder.size.value().toString()).toBe('100');
    });

    it('REJECTED: откатывает резервацию, НЕ сохраняет Order, возвращает Err', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const cancelOrder = jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' }));
      const exchangeClient: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'REJECTED', reason: 'FOK order could not be filled' }),
        ),
        cancelOrder,
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/rejected/i);
      expect(orderRepo.save).not.toHaveBeenCalled();
      expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
      // Нет orderId (REJECTED никогда его не содержит) — cancel не имеет смысла.
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('UNKNOWN с orderId: откатывает резервацию, пытается best-effort cancel, возвращает Err', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const cancelOrder = jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' }));
      const exchangeClient: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({
            status: 'UNKNOWN',
            reason: 'ambiguous venue response',
            orderId: 'exchange-order-1' as unknown as OrderId,
            effectiveSize: makeQty('100'),
          }),
        ),
        cancelOrder,
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/ambiguous/i);
      expect(orderRepo.save).not.toHaveBeenCalled();
      expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
      expect(cancelOrder).toHaveBeenCalledWith('exchange-order-1');
    });

    it('UNKNOWN без orderId: резервация УДЕРЖАНА (venue-ордер мог создаться), НЕ пытается cancel, возвращает Err', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const cancelOrder = jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' }));
      const exchangeClient: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'UNKNOWN', reason: 'ambiguous, no orderId returned' }),
        ),
        cancelOrder,
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(orderRepo.save).not.toHaveBeenCalled();
      // Без venueOrderId cancel невозможен, а ордер мог создаться → резервацию
      // НЕ освобождаем (иначе двойной учёт при последующем fill).
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      expect(cancelOrder).not.toHaveBeenCalled();
    });
  });

  // ── Reconciliation issues (optional dependency) ───────────────────────────

  describe('reconciliation issues', () => {
    function makeUnknownExchangeClient(withOrderId: boolean): IExchangeClient {
      return {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok(
            withOrderId
              ? {
                  status: 'UNKNOWN',
                  reason: 'ambiguous venue response',
                  orderId: 'exchange-order-1' as unknown as OrderId,
                  effectiveSize: makeQty('100'),
                }
              : { status: 'UNKNOWN', reason: 'ambiguous, no orderId returned' },
          ),
        ),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };
    }

    function makeFilledExchangeClient(): IExchangeClient {
      return {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({
            status: 'FILLED',
            orderId: 'exchange-order-1' as unknown as OrderId,
            effectiveSize: makeQty('100'),
            filledSize: makeQty('100'),
          }),
        ),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };
    }

    it('UNKNOWN с orderId: создаёт SUBMIT_UNKNOWN_OUTCOME issue с детерминированным id, результат прежний Err', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new PlaceOrderUseCase({
        ...deps,
        exchangeClient: makeUnknownExchangeClient(true),
        reconciliationIssues,
      });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/ambiguous/i);
      expect(reconciliationIssues.add).toHaveBeenCalledTimes(1);
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        type: string;
        status: string;
        reason: string;
        orderId: unknown;
        accountId: unknown;
        instrumentId: unknown;
        createdAt: Date;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe('reconciliation:submit:exchange-order-1:unknown');
      expect(issue.type).toBe('SUBMIT_UNKNOWN_OUTCOME');
      expect(issue.status).toBe('OPEN');
      expect(issue.reason).toBe('ambiguous venue response');
      expect(issue.orderId).toBe('exchange-order-1');
      expect(issue.accountId).toBe(ACCOUNT_ID);
      expect(issue.instrumentId).toBe(INSTRUMENT_ID);
      expect(issue.createdAt).toEqual(new Date('2024-01-01T00:00:00.000Z')); // clock.now()
      expect(issue.context).toMatchObject({
        clientOrderId: String(ORDER_ID),
        venueOrderId: 'exchange-order-1',
        cancelAttempted: true,
        // cancel вернул CANCELLED → резервация освобождена, held=false.
        cancelOutcome: 'CANCELLED',
        reservationHeld: false,
      });
    });

    it('UNKNOWN без orderId: создаёт issue с id на основе clientOrderId, cancelAttempted=false', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new PlaceOrderUseCase({
        ...deps,
        exchangeClient: makeUnknownExchangeClient(false),
        reconciliationIssues,
      });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(reconciliationIssues.add).toHaveBeenCalledTimes(1);
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        type: string;
        orderId?: unknown;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe(`reconciliation:submit-client:${String(ORDER_ID)}:unknown`);
      expect(issue.type).toBe('SUBMIT_UNKNOWN_OUTCOME');
      expect(issue.orderId).toBeUndefined();
      expect(issue.context).toMatchObject({
        clientOrderId: String(ORDER_ID),
        cancelAttempted: false,
      });
      expect(issue.context).not.toHaveProperty('venueOrderId');
    });

    it('FILLED: создаёт SUBMIT_FILLED_WITHOUT_FILL_DETAILS issue и всё равно возвращает Ok(venueOrderId)', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new PlaceOrderUseCase({
        ...deps,
        exchangeClient: makeFilledExchangeClient(),
        reconciliationIssues,
      });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('exchange-order-1');
      expect(orderRepo.save).toHaveBeenCalled();
      expect(deps.orderStateStore.markOrderFillMatched).toHaveBeenCalled();
      expect(reconciliationIssues.add).toHaveBeenCalledTimes(1);
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
        id: string;
        type: string;
        status: string;
        reason: string;
        orderId: unknown;
        context?: Record<string, unknown>;
      };
      expect(issue.id).toBe('reconciliation:submit:exchange-order-1:filled-without-fill-details');
      expect(issue.type).toBe('SUBMIT_FILLED_WITHOUT_FILL_DETAILS');
      expect(issue.status).toBe('OPEN');
      expect(issue.reason).toBe('Submit returned FILLED without fill details; waiting for WS/reconciliation fill');
      expect(issue.orderId).toBe('exchange-order-1');
      expect(issue.context).toMatchObject({
        clientOrderId: String(ORDER_ID),
        filledSize: '100',
        effectiveSize: '100',
        side: 'BUY',
        price: '0.65',
      });
    });

    it('PARTIALLY_FILLED: issue НЕ создаётся (ордер live, pending marker достаточен)', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      const exchangeClient: IExchangeClient = {
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({
            status: 'PARTIALLY_FILLED',
            orderId: 'exchange-order-1' as unknown as OrderId,
            effectiveSize: makeQty('100'),
            filledSize: makeQty('40'),
            remainingSize: makeQty('60'),
          }),
        ),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok({ status: 'CANCELLED' })),
        getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
        getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient, reconciliationIssues });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(reconciliationIssues.add).not.toHaveBeenCalled();
    });

    it('сбой reconciliationIssues.add в FILLED-ветке не ломает успешный результат', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      (reconciliationIssues.add as ReturnType<typeof jest.fn>).mockImplementation(() =>
        Promise.reject(new Error('issue store down')),
      );
      const useCase = new PlaceOrderUseCase({
        ...deps,
        exchangeClient: makeFilledExchangeClient(),
        reconciliationIssues,
      });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('exchange-order-1');
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to add reconciliation issue',
        expect.objectContaining({ issueType: 'SUBMIT_FILLED_WITHOUT_FILL_DETAILS' }),
      );
      // publishAll всё равно выполнен — flow не прерван.
      expect(eventBus.publishAll).toHaveBeenCalled();
    });

    it('сбой reconciliationIssues.add в UNKNOWN-ветке не меняет исходный Err', async () => {
      const reconciliationIssues = makeReconciliationIssueRepo();
      (reconciliationIssues.add as ReturnType<typeof jest.fn>).mockImplementation(() =>
        Promise.reject(new Error('issue store down')),
      );
      const useCase = new PlaceOrderUseCase({
        ...deps,
        exchangeClient: makeUnknownExchangeClient(true),
        reconciliationIssues,
      });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      // Err про ambiguous submit, а не про issue store.
      if (!result.ok) expect(result.error.message).toMatch(/ambiguous/i);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to add reconciliation issue',
        expect.objectContaining({ issueType: 'SUBMIT_UNKNOWN_OUTCOME' }),
      );
    });

    it('без reconciliationIssues (optional dep) поведение прежнее — UNKNOWN возвращает Err без issue', async () => {
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient: makeUnknownExchangeClient(true) });
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(false);
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
    const useCase = new PlaceOrderUseCase({ ...deps, portfolioService });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(false);
  });

  // ── Commit-critical reserve+journal (Этап 2) ─────────────────────────────────

  describe('commit-critical journal HELD (Этап 2.2)', () => {
    it('markReservationHeld → Err: submit НЕ вызывается, Portfolio восстановлен (compensating release), submission FAILED (retryable)', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const submissionsStub = makeSubmissionsStub({
        markReservationHeld: jest.fn<IOrderSubmissionRepository['markReservationHeld']>()
          .mockResolvedValue(Err(new (await import('@polymarket/ports')).ReservationTransitionError('INVARIANT_VIOLATION', 'journal write failed'))),
      });
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, submissions: submissionsStub });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(exchangeClient.submitOrder).not.toHaveBeenCalled();
      // Компенсация: reserve был выполнен → release тем же объёмом.
      expect(portfolio.reserveForOrder).toHaveBeenCalledTimes(1);
      expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
      // Компенсация успешна → submission помечена FAILED (retry разрешён).
      expect(submissionsStub.markFailed).toHaveBeenCalledWith(
        ORDER_ID, expect.stringContaining('JOURNAL_HELD_FAILED'), expect.any(Date),
      );
    });

    it('markReservationHeld падает И compensating release падает: submission НЕ retryable (без markFailed), journal → RECONCILIATION_REQUIRED, issue', async () => {
      const portfolio = makePortfolio();
      (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('cannot unfreeze')),
      );
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const submissionsStub = makeSubmissionsStub({
        markReservationHeld: jest.fn<IOrderSubmissionRepository['markReservationHeld']>()
          .mockRejectedValue(new Error('journal unavailable')),
      });
      const useCase = new PlaceOrderUseCase({
        ...deps, portfolioService, submissions: submissionsStub, reconciliationIssues,
      });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      expect(exchangeClient.submitOrder).not.toHaveBeenCalled();
      // Submission НЕ FAILED → begin при retry вернёт IN_PROGRESS (blocked).
      expect(submissionsStub.markFailed).not.toHaveBeenCalled();
      // Journal помечен RECONCILIATION_REQUIRED (best-effort).
      expect(submissionsStub.applyReservationTransition).toHaveBeenCalledWith(
        ORDER_ID,
        expect.objectContaining({ status: 'RECONCILIATION_REQUIRED' }),
      );
      // Blocking issue создана.
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { type: string; reason: string })
        .find((i) => i.type === 'ORDER_PORTFOLIO_DESYNC');
      expect(issue).toBeDefined();
      expect(issue!.reason).toContain('journal HELD failed');
    });
  });

  describe('definite rejection rollback (Этап 2.3)', () => {
    it('DEFINITELY_NOT_SUBMITTED + release failure: submission НЕ FAILED, journal RECONCILIATION_REQUIRED, второй execute НЕ reserve и НЕ submit', async () => {
      const portfolio = makePortfolio();
      (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('cannot unfreeze')),
      );
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const exchangeClient2: IExchangeClient = {
        ...makeExchangeClient(),
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Err(new ExchangeError('preflight rejected', { submitOutcome: 'DEFINITELY_NOT_SUBMITTED' })),
        ),
      };
      // Реальный journal — проверяем реальные статусы записи.
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient: exchangeClient2 });

      const first = await useCase.execute(makeInput());
      expect(first.ok).toBe(false);

      const record = await submissions.get(ORDER_ID);
      // Release упал → journal НЕ SETTLED, submission НЕ FAILED (остаётся SUBMITTING).
      expect(record?.status).toBe('SUBMITTING');
      expect(record?.reservation.status).toBe('RECONCILIATION_REQUIRED');

      // Второй execute: begin → IN_PROGRESS → Err, без reserve/submit.
      (portfolio.reserveForOrder as ReturnType<typeof jest.fn>).mockClear();
      (exchangeClient2.submitOrder as ReturnType<typeof jest.fn>).mockClear();
      const second = await useCase.execute(makeInput());
      expect(second.ok).toBe(false);
      expect(portfolio.reserveForOrder).not.toHaveBeenCalled();
      expect(exchangeClient2.submitOrder).not.toHaveBeenCalled();
    });

    it('REJECTED + release failure: submission НЕ FAILED, retry заблокирован (без reserve/submit)', async () => {
      const portfolio = makePortfolio();
      (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('cannot unfreeze')),
      );
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const exchangeClient2: IExchangeClient = {
        ...makeExchangeClient(),
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'REJECTED', reason: 'FOK could not fill' }),
        ),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient: exchangeClient2 });

      const first = await useCase.execute(makeInput());
      expect(first.ok).toBe(false);

      const record = await submissions.get(ORDER_ID);
      expect(record?.status).toBe('SUBMITTING');
      expect(record?.reservation.status).toBe('RECONCILIATION_REQUIRED');

      (portfolio.reserveForOrder as ReturnType<typeof jest.fn>).mockClear();
      (exchangeClient2.submitOrder as ReturnType<typeof jest.fn>).mockClear();
      const second = await useCase.execute(makeInput());
      expect(second.ok).toBe(false);
      expect(portfolio.reserveForOrder).not.toHaveBeenCalled();
      expect(exchangeClient2.submitOrder).not.toHaveBeenCalled();
    });

    it('REJECTED + успешный rollback: journal SETTLED (remaining=0), submission FAILED → retry разрешён', async () => {
      const exchangeClient2: IExchangeClient = {
        ...makeExchangeClient(),
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'REJECTED', reason: 'FOK could not fill' }),
        ),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient: exchangeClient2 });

      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(false);

      const record = await submissions.get(ORDER_ID);
      expect(record?.status).toBe('FAILED');
      expect(record?.reservation).toMatchObject({ status: 'SETTLED', remaining: '0' });
    });
  });

  describe('post-submit rollback + journal (Этап 2.4)', () => {
    /** Триггер post-submit rollback: venue вернул невалидный effectiveSize (0). */
    function makeInvalidEffectiveSizeExchange(): IExchangeClient {
      return {
        ...makeExchangeClient(),
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'OPEN', orderId: 'exchange-order-1' as unknown as OrderId, effectiveSize: makeQty('0'), remainingSize: makeQty('0') }),
        ),
      };
    }

    it('confirmed post-submit cancel: Portfolio released И journal SETTLED', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const useCase = new PlaceOrderUseCase({
        ...deps, portfolioService, exchangeClient: makeInvalidEffectiveSizeExchange(),
      });

      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(false);

      expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
      const record = await submissions.get(ORDER_ID);
      expect(record?.status).toBe('UNKNOWN'); // venue-ордер существовал — retry заблокирован
      expect(record?.reservation).toMatchObject({ status: 'SETTLED', remaining: '0' });
    });

    it('post-submit Portfolio release failure: journal НЕ SETTLED (RECONCILIATION_REQUIRED)', async () => {
      const portfolio = makePortfolio();
      (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
        Err(new TradingError('cannot unfreeze')),
      );
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const useCase = new PlaceOrderUseCase({
        ...deps, portfolioService, exchangeClient: makeInvalidEffectiveSizeExchange(),
      });

      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(false);

      const record = await submissions.get(ORDER_ID);
      expect(record?.reservation.status).toBe('RECONCILIATION_REQUIRED');
      expect(record?.reservation.status).not.toBe('SETTLED');
    });

    it('uncertain rollback cancel (UNKNOWN_RETRY_NEEDED): Portfolio НЕ тронут, journal остаётся HELD, ставится блокирующий marker', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const exchangeClient2: IExchangeClient = {
        ...makeInvalidEffectiveSizeExchange(),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(
          Ok({ status: 'UNKNOWN_RETRY_NEEDED', reason: 'gateway timeout' }),
        ),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient: exchangeClient2 });

      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(false);

      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      const record = await submissions.get(ORDER_ID);
      expect(record?.reservation.status).toBe('HELD');
      // Блокирующий instrument-marker поставлен.
      expect(deps.orderStateStore.markInFlightFill).toHaveBeenCalled();
    });
  });

  describe('второй submission attempt (Этап 2, тест 7)', () => {
    it('operation IDs разных attempts различаются — второй rollback реально применяется', async () => {
      const exchangeClient2: IExchangeClient = {
        ...makeExchangeClient(),
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'REJECTED', reason: 'FOK could not fill' }),
        ),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient: exchangeClient2 });

      // Attempt 1: REJECTED → подтверждённый rollback → FAILED.
      const first = await useCase.execute(makeInput());
      expect(first.ok).toBe(false);
      const afterFirst = await submissions.get(ORDER_ID);
      expect(afterFirst?.status).toBe('FAILED');
      expect(afterFirst?.attempt).toBe(1);
      expect(afterFirst?.reservation).toMatchObject({ status: 'SETTLED', remaining: '0' });

      // Attempt 2: retry → hold заново → REJECTED → rollback attempt-scoped opId.
      const second = await useCase.execute(makeInput());
      expect(second.ok).toBe(false);
      const afterSecond = await submissions.get(ORDER_ID);
      expect(afterSecond?.attempt).toBe(2);
      // Если бы operationId совпадал с attempt 1, release был бы проглочен
      // идемпотентностью → journal остался бы HELD и markFailed бы не случился.
      expect(afterSecond?.status).toBe('FAILED');
      expect(afterSecond?.reservation).toMatchObject({ status: 'SETTLED', remaining: '0' });
    });
  });

  describe('unsettled fills guard в use-case (Этап 2.1)', () => {
    it('hasUnsettledFills=true → Err, reserve/submit/begin НЕ вызываются', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      (deps.orderStateStore.hasUnsettledFills as ReturnType<typeof jest.fn>).mockReturnValue(true);
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/unsettled fills/i);
      expect(portfolio.reserveForOrder).not.toHaveBeenCalled();
      expect(exchangeClient.submitOrder).not.toHaveBeenCalled();
      // begin() не выполнялся — записи нет.
      expect(await submissions.get(ORDER_ID)).toBeUndefined();
    });
  });

  describe('begin → RECONCILIATION_REQUIRED (Этап 1.2/2)', () => {
    it('FAILED + held reservation: risk/reserve/submit НЕ выполняются, issue создана, Err', async () => {
      // Подготовка: запись FAILED с held-резервацией (unsafe retry).
      await submissions.begin({
        clientOrderId: ORDER_ID,
        accountId: ACCOUNT_ID,
        instrumentId: INSTRUMENT_ID,
        fingerprint: [
          `account=${accountIdToString(ACCOUNT_ID)}`,
          `instrument=${String(INSTRUMENT_ID)}`,
          `asset=${String(ASSET_ID)}`,
          'side=BUY',
          'price=0.65',
          'size=100',
          'orderType=',
          'postOnly=false',
          'strategyId=test-strategy',
        ].join('|'),
        side: 'BUY',
        orderPrice: '0.65',
        requestedSize: '100',
        now: new Date('2024-01-01T00:00:00.000Z'),
      });
      await submissions.markReservationHeld(ORDER_ID, '65', new Date());
      await submissions.markFailed(ORDER_ID, 'submit failed', new Date());

      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, reconciliationIssues });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/unresolved reservation/i);
      expect(portfolio.reserveForOrder).not.toHaveBeenCalled();
      expect(exchangeClient.submitOrder).not.toHaveBeenCalled();
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { id: string; reason: string })
        .find((i) => i.id.includes('retry-blocked-unresolved-reservation'));
      expect(issue).toBeDefined();
      expect(issue!.reason).toContain('SUBMISSION_RETRY_BLOCKED_UNRESOLVED_RESERVATION');
    });
  });

  describe('exception boundaries (P1): rejected Promise вместо Result', () => {
    it('submitOrder отклоняет Promise → консервативно MAY_HAVE_BEEN_SUBMITTED: Err, резервация held, submission UNKNOWN, issue', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const reconciliationIssues = makeReconciliationIssueRepo();
      const exchangeClient2: IExchangeClient = {
        ...makeExchangeClient(),
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockRejectedValue(new Error('socket hang up')),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient: exchangeClient2, reconciliationIssues });

      // НЕ бросает — Err (saga recovery выполняется).
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      // Ордер МОГ создаться на venue — резервация held (не release).
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      // Submission заблокирована как UNKNOWN (retry запрещён), journal HELD.
      const record = await submissions.get(ORDER_ID);
      expect(record?.status).toBe('UNKNOWN');
      expect(record?.reservation.status).toBe('HELD');
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { type: string; reason: string })
        .find((i) => i.type === 'SUBMIT_UNKNOWN_OUTCOME');
      expect(issue).toBeDefined();
      expect(issue!.reason).toContain('socket hang up');
    });

    it('rollback cancelOrder отклоняет Promise → transport-политика: Err без throw, резервация held, journal HELD, submission UNKNOWN', async () => {
      const portfolio = makePortfolio();
      const store = makePortfolioStore(portfolio);
      const portfolioService = new PortfolioService(store, logger);
      const exchangeClient2: IExchangeClient = {
        ...makeExchangeClient(),
        // Триггер post-submit rollback: невалидный effectiveSize (0).
        submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
          Ok({ status: 'OPEN', orderId: 'exchange-order-1' as unknown as OrderId, effectiveSize: makeQty('0'), remainingSize: makeQty('0') }),
        ),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockRejectedValue(new Error('gateway down')),
      };
      const useCase = new PlaceOrderUseCase({ ...deps, portfolioService, exchangeClient: exchangeClient2 });

      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      // Cancel не подтверждён → Portfolio НЕ released, journal held.
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      const record = await submissions.get(ORDER_ID);
      expect(record?.status).toBe('UNKNOWN');
      expect(record?.reservation.status).toBe('HELD');
    });
  });

  describe('outbox enqueue Err (Этап 2, тест 9)', () => {
    it('enqueue → Err: Place остаётся committed (Ok), создаётся EVENT_PUBLISH_FAILED issue', async () => {
      const { OutboxEnqueueError } = await import('@polymarket/ports');
      const reconciliationIssues = makeReconciliationIssueRepo();
      const failingOutbox = {
        enqueue: jest.fn().mockImplementation(async () => Err(new OutboxEnqueueError('queue full'))),
        flush: jest.fn().mockImplementation(async () => undefined),
      } as unknown as PlaceOrderDeps['orderedEventOutbox'];
      const useCase = new PlaceOrderUseCase({
        ...deps, orderedEventOutbox: failingOutbox, reconciliationIssues,
      });

      const result = await useCase.execute(makeInput());

      // Business commit состоялся — Ok(venueOrderId), несмотря на сбой enqueue.
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('exchange-order-1');
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { type: string; reason: string })
        .find((i) => i.type === 'EVENT_PUBLISH_FAILED');
      expect(issue).toBeDefined();
      expect(issue!.reason).toContain('queue full');
    });
  });

  // ── Регрессия: risk projection (Phase 1) + expiry gate (Phase 3) ──────────

  describe('risk projection + expiry gate (реальный OrderRiskChecker)', () => {
    /**
     * Минимальный стаб IMarketCatalog: `get()` возвращает инструмент с заданным
     * `expiresAt.toNumber()` (ms) либо undefined (инструмент неизвестен).
     */
    function makeCatalog(expiresAtMs?: number): IMarketCatalog {
      const info = expiresAtMs === undefined
        ? undefined
        : ({ expiresAt: { toNumber: () => expiresAtMs } } as unknown as InstrumentInfo);
      return {
        get: jest.fn<IMarketCatalog['get']>().mockReturnValue(info),
        getByMarketId: jest.fn(),
        getAnyInstrumentByMarketIdForMetadataOnly: jest.fn(),
        getAllByMarketId: jest.fn().mockReturnValue([]),
        getAll: jest.fn().mockReturnValue([]),
        register: jest.fn(),
        registerMarket: jest.fn(),
        removeMarket: jest.fn(),
        remove: jest.fn(),
        clear: jest.fn(),
      } as unknown as IMarketCatalog;
    }

    function makeRealChecker(params: Parameters<typeof RiskPolicy.create>[0]): IOrderRiskChecker {
      const r = RiskPolicy.create(params);
      if (!r.ok) throw r.error;
      return new OrderRiskChecker(r.value, logger);
    }

    it('BUY блокируется RISK_INPUT_INCOMPLETE, если expiry-лимит включён, а инструмента нет в каталоге', async () => {
      const riskChecker = makeRealChecker({ minTimeToExpiryMs: 60_000 });
      const useCase = new PlaceOrderUseCase({ ...deps, riskChecker, marketCatalog: makeCatalog(undefined) });
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result.error as RiskViolationError).riskCode).toBe('RISK_INPUT_INCOMPLETE');
      }
      // Ордер не отправлялся на биржу.
      expect(exchangeClient.submitOrder).not.toHaveBeenCalled();
    });

    it('BUY проходит при доступном будущем expiry', async () => {
      const riskChecker = makeRealChecker({ minTimeToExpiryMs: 60_000 });
      // clock = 2024-01-01; expiry через час.
      const expiresAtMs = new Date('2024-01-01T01:00:00.000Z').getTime();
      const useCase = new PlaceOrderUseCase({ ...deps, riskChecker, marketCatalog: makeCatalog(expiresAtMs) });
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(true);
    });

    it('BUY блокируется TOO_CLOSE_TO_EXPIRY, если рынок уже истёк (отрицательное время)', async () => {
      const riskChecker = makeRealChecker({ minTimeToExpiryMs: 0 });
      const expiresAtMs = new Date('2023-12-31T23:59:00.000Z').getTime(); // в прошлом
      const useCase = new PlaceOrderUseCase({ ...deps, riskChecker, marketCatalog: makeCatalog(expiresAtMs) });
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result.error as RiskViolationError).riskCode).toBe('TOO_CLOSE_TO_EXPIRY');
      }
    });

    it('SELL проходит при недоступном expiry (expiry-лимит включён)', async () => {
      const riskChecker = makeRealChecker({ minTimeToExpiryMs: 60_000 });
      const useCase = new PlaceOrderUseCase({ ...deps, riskChecker, marketCatalog: makeCatalog(undefined) });
      const result = await useCase.execute(makeInput({ side: 'SELL' }));
      expect(result.ok).toBe(true);
    });

    it('position limit: pending BUY первого ордера учитывается — второй BUY отклоняется', async () => {
      // maxPositionSize=150 токенов. A: price 0.5 × size 100 = 50 USDC held →
      // pending = 50/0.5 = 100 токенов. A: 0 + 0 + 100 = 100 <= 150 → проходит.
      // B (тот же account+instrument): 0 (filled) + 100 (pending A) + 100 (new) = 200 > 150 → reject.
      const riskChecker = makeRealChecker({ maxPositionSize: new Decimal('150') });
      const useCase = new PlaceOrderUseCase({ ...deps, riskChecker });

      const orderA = 'order-A' as unknown as OrderId;
      const orderB = 'order-B' as unknown as OrderId;

      const resA = await useCase.execute(makeInput({ orderId: orderA, price: makePrice('0.5'), size: makeQty('100') }));
      expect(resA.ok).toBe(true);

      const resB = await useCase.execute(makeInput({ orderId: orderB, price: makePrice('0.5'), size: makeQty('100') }));
      expect(resB.ok).toBe(false);
      if (!resB.ok) {
        expect((resB.error as RiskViolationError).riskCode).toBe('POSITION_LIMIT_EXCEEDED');
      }
    });

    it('fail-closed: сбой getPendingBuyQuantityForInstrument блокирует BUY', async () => {
      const riskChecker = makeRealChecker({ maxPositionSize: new Decimal('150') });
      const failingSubmissions = makeSubmissionsStub({
        getPendingBuyQuantityForInstrument: jest.fn<IOrderSubmissionRepository['getPendingBuyQuantityForInstrument']>()
          .mockResolvedValue(Err(new ReservationTransitionError('INVARIANT_VIOLATION', 'corrupt reservation/price data'))),
      });
      const useCase = new PlaceOrderUseCase({ ...deps, riskChecker, submissions: failingSubmissions });
      const result = await useCase.execute(makeInput());
      expect(result.ok).toBe(false);
      // Типизированный RISK_STATE_UNAVAILABLE (метрики отличают от нарушения лимита).
      if (!result.ok) {
        expect((result.error as RiskViolationError).riskCode).toBe('RISK_STATE_UNAVAILABLE');
      }
      // Ордер не отправлялся на биржу (fail-closed до reserve/submit).
      expect(exchangeClient.submitOrder).not.toHaveBeenCalled();
    });
  });
});
