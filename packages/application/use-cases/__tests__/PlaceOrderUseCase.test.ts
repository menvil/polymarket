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
  IReconciliationIssueRepository,
} from '@polymarket/ports';
import { VersionConflictError } from '@polymarket/ports';
import type { IOrderRiskChecker, RiskViolationError } from '@polymarket/risk';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { AccountId, AssetId, InstrumentId, OrderId } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import { RiskViolationError as RiskViolationErrorClass } from '@polymarket/risk';
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

function makeReconciliationIssueRepo(): IReconciliationIssueRepository {
  return {
    add: jest.fn<IReconciliationIssueRepository['add']>().mockResolvedValue(undefined),
    listOpen: jest.fn<IReconciliationIssueRepository['listOpen']>().mockResolvedValue([]),
    get: jest.fn<IReconciliationIssueRepository['get']>().mockResolvedValue(undefined),
    markResolved: jest.fn<IReconciliationIssueRepository['markResolved']>().mockResolvedValue(undefined),
  };
}

function makeRiskChecker(pass = true): IOrderRiskChecker {
  return {
    checkBeforeOrder: jest.fn<IOrderRiskChecker['checkBeforeOrder']>().mockReturnValue(
      pass
        ? Ok(undefined)
        : Err(new RiskViolationErrorClass('MAX_OPEN_ORDERS_EXCEEDED', 'Too many open orders', {})),
    ),
    updateParams: jest.fn<IOrderRiskChecker['updateParams']>(),
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
  let deps: PlaceOrderDeps;

  beforeEach(() => {
    logger = makeLogger();
    clock = makeClock();
    eventBus = makeEventBus();
    orderRepo = makeOrderRepo();
    portfolioStore = makePortfolioStore();
    exchangeClient = makeExchangeClient(); // default: 'exchange-order-1' (venueOrderId)
    riskChecker = makeRiskChecker(true);

    const portfolioService = new PortfolioService(portfolioStore, logger);

    deps = {
      riskChecker,
      orderRepo,
      portfolioService,
      exchangeClient,
      orderStateStore: {
        markOrderFillMatched: jest.fn(),
        hasMatchedFills: jest.fn().mockReturnValue(false),
        getMatchedFillIds: jest.fn().mockReturnValue([]),
        getOpenOrdersByInstrument: jest.fn().mockReturnValue([]),
        hasInFlightFills: jest.fn().mockReturnValue(false),
        markInFlightFill: jest.fn(),
        clearInFlightFill: jest.fn(),
        getInFlightFills: jest.fn().mockReturnValue([]),
      } as unknown as IOrderStateStore,
      eventBus,
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
    expect(logger.info).toHaveBeenCalledWith('Order placed successfully', expect.any(Object));
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
      deps = { ...deps, portfolioService, orderRepo };
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
        'Rollback cancel failed — order already filled on exchange, manual reconciliation/fill expected',
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
        'Rollback cancel outcome unclear — venue order may still be live, manual reconciliation required',
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
      const useCase = new PlaceOrderUseCase({ ...deps, orderStateStore, eventBus: eventBusSpy, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
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

    it('UNKNOWN без orderId: откатывает резервацию, НЕ пытается cancel, возвращает Err', async () => {
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
      expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
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
        rollbackReleaseOk: true,
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
});
