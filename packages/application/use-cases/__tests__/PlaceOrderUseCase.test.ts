import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PlaceOrderUseCase } from '../src/PlaceOrderUseCase.js';
import { OrderService } from '../src/services/OrderService.js';
import { PortfolioService } from '../src/services/PortfolioService.js';
import type { PlaceOrderInput, PlaceOrderDeps } from '../src/PlaceOrderUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderRepository, IExchangeClient, IPortfolioStore } from '@polymarket/ports';
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
  };
}

function makeOrderRepo(): IOrderRepository {
  return {
    get: jest.fn().mockImplementation(() => Promise.resolve(undefined)) as unknown as IOrderRepository['get'],
    save: jest.fn().mockImplementation(() => Promise.resolve()) as unknown as IOrderRepository['save'],
    delete: jest.fn().mockImplementation(() => Promise.resolve()) as unknown as IOrderRepository['delete'],
    getByStrategyId: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getByStrategyId'],
    countByStrategyId: jest.fn().mockImplementation(() => Promise.resolve(0)) as unknown as IOrderRepository['countByStrategyId'],
    getAll: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getAll'],
    getByMarketId: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getByMarketId'],
  };
}

function makeExchangeClient(orderId?: OrderId): IExchangeClient {
  const id = orderId ?? ('exchange-order-1' as unknown as OrderId);
  return {
    submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(Ok(id)),
    cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok(undefined)),
    getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
    getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
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
    exchangeClient = makeExchangeClient(ORDER_ID);
    riskChecker = makeRiskChecker(true);

    const portfolioService = new PortfolioService(portfolioStore, logger);
    const orderService = new OrderService(orderRepo, logger);

    deps = {
      riskChecker,
      orderService,
      portfolioService,
      exchangeClient,
      eventBus,
      clock,
      logger,
    };
  });

  // ── Успешный сценарий ─────────────────────────────────────────────────────

  it('возвращает Ok(orderId) при успешном размещении', async () => {
    const useCase = new PlaceOrderUseCase(deps);
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(ORDER_ID);
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
      cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok(undefined)),
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
      cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok(undefined)),
      getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
      getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([])),
    };
    const useCase = new PlaceOrderUseCase({ ...deps, exchangeClient: failingExchange });
    await useCase.execute(makeInput());
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  // ── Portfolio не найден ───────────────────────────────────────────────────

  it('возвращает Err если portfolio не найден', async () => {
    const emptyStore: IPortfolioStore = {
      get: jest.fn<IPortfolioStore['get']>().mockReturnValue(undefined),
      save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
    };
    const portfolioService = new PortfolioService(emptyStore, logger);
    const useCase = new PlaceOrderUseCase({ ...deps, portfolioService });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(false);
  });
});
