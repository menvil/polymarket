import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CancelOrderUseCase } from '../src/CancelOrderUseCase.js';
import { OrderService } from '../src/services/OrderService.js';
import { PortfolioService } from '../src/services/PortfolioService.js';
import type { CancelOrderDeps, CancelOrderInput } from '../src/CancelOrderUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderRepository, IPortfolioStore, IExchangeClient, IOrderStateStore } from '@polymarket/ports';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { AccountId, AssetId, InstrumentId, OrderId } from '@polymarket/ids';
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
const ASSET_ID = 'token-abc' as unknown as AssetId;
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
  };
}

function makeOrderRepo(order?: Order): IOrderRepository {
  return {
    get: jest.fn().mockImplementation(() => Promise.resolve(order)) as unknown as IOrderRepository['get'],
    save: jest.fn().mockImplementation(() => Promise.resolve()) as unknown as IOrderRepository['save'],
    delete: jest.fn().mockImplementation(() => Promise.resolve()) as unknown as IOrderRepository['delete'],
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
  };
}

function makeExchangeClient(success = true): IExchangeClient {
  return {
    submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(Ok(ORDER_ID)),
    cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(
      success ? Ok(undefined) : Err(new TradingError('Exchange error') as never),
    ),
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CancelOrderUseCase', () => {
  let logger: ILogger;
  let eventBus: IEventBus;
  let orderRepo: IOrderRepository;
  let orderStateStore: IOrderStateStore;
  let portfolioStore: IPortfolioStore;
  let exchangeClient: IExchangeClient;
  let deps: CancelOrderDeps;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    const order = makeOpenOrder();
    orderRepo = makeOrderRepo(order);
    orderStateStore = makeOrderStateStore(order);
    portfolioStore = makePortfolioStore();
    exchangeClient = makeExchangeClient(true);

    const orderService = new OrderService(orderRepo, logger);
    const portfolioService = new PortfolioService(portfolioStore, logger);

    deps = {
      orderService,
      portfolioService,
      orderRepo,
      orderStateStore,
      exchangeClient,
      eventBus,
      logger,
    };
  });

  // ── Успешный сценарий ─────────────────────────────────────────────────────

  it('возвращает Ok(void) при успешной отмене', async () => {
    const useCase = new CancelOrderUseCase(deps);
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
  });

  it('сохраняет отменённый ордер в репозиторий', async () => {
    const useCase = new CancelOrderUseCase(deps);
    await useCase.execute(makeInput());
    expect(orderRepo.save).toHaveBeenCalled();
  });

  it('вызывает cancelOrder на бирже', async () => {
    const useCase = new CancelOrderUseCase(deps);
    await useCase.execute(makeInput());
    expect(exchangeClient.cancelOrder).toHaveBeenCalledWith(ORDER_ID);
  });

  it('публикует события', async () => {
    const useCase = new CancelOrderUseCase(deps);
    await useCase.execute(makeInput());
    expect(eventBus.publishAll).toHaveBeenCalled();
  });

  it('логирует info при успешной отмене', async () => {
    const useCase = new CancelOrderUseCase(deps);
    await useCase.execute(makeInput());
    expect(logger.info).toHaveBeenCalledWith('Order cancelled successfully', expect.any(Object));
  });

  // ── Ордер не найден ───────────────────────────────────────────────────────

  it('возвращает Err если ордер не найден', async () => {
    orderRepo = makeOrderRepo(undefined);
    const orderService = new OrderService(orderRepo, logger);
    const useCase = new CancelOrderUseCase({ ...deps, orderService, orderRepo });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/Order not found/);
  });

  // ── Ордер в терминальном статусе ──────────────────────────────────────────

  it('возвращает Ok если ордер уже отменён (идемпотентность)', async () => {
    const cancelledOrder = (() => {
      const r = Order.create({
        id: ORDER_ID,
        asset: ASSET_ID,
        side: 'BUY',
        price: makePrice('0.65') as never,
        size: makeQty('100') as never,
        timestamp: { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '2024-01-01T00:00:00.000Z' } as never,
      });
      if (!r.ok) throw new Error('Cannot create');
      const acc = r.value.accept();
      if (!acc.ok) throw new Error('Cannot accept');
      const can = acc.value.cancel();
      if (!can.ok) throw new Error('Cannot cancel');
      can.value.pullEvents();
      return can.value;
    })();

    orderRepo = makeOrderRepo(cancelledOrder);
    const orderService = new OrderService(orderRepo, logger);
    const useCase = new CancelOrderUseCase({ ...deps, orderService, orderRepo });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
  });

  it('не вызывает cancelOrder на бирже для терминального ордера', async () => {
    const cancelledOrder2 = (() => {
      const r = Order.create({
        id: ORDER_ID,
        asset: ASSET_ID,
        side: 'BUY',
        price: makePrice('0.65') as never,
        size: makeQty('100') as never,
        timestamp: { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '2024-01-01T00:00:00.000Z' } as never,
      });
      if (!r.ok) throw new Error('Cannot create');
      const acc = r.value.accept();
      if (!acc.ok) throw new Error('Cannot accept');
      const can = acc.value.cancel();
      if (!can.ok) throw new Error('Cannot cancel');
      can.value.pullEvents();
      return can.value;
    })();

    orderRepo = makeOrderRepo(cancelledOrder2);
    const orderService = new OrderService(orderRepo, logger);
    const useCase = new CancelOrderUseCase({ ...deps, orderService, orderRepo });
    await useCase.execute(makeInput());
    // Для терминального ордера не вызываем cancelOrder
    expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
  });

  // ── Best-effort биржевая отмена ────────────────────────────────────────────

  it('возвращает Ok даже если биржа вернула ошибку (best effort)', async () => {
    exchangeClient = makeExchangeClient(false);
    const useCase = new CancelOrderUseCase({ ...deps, exchangeClient });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
  });

  it('логирует warn при ошибке биржи (best effort)', async () => {
    exchangeClient = makeExchangeClient(false);
    const useCase = new CancelOrderUseCase({ ...deps, exchangeClient });
    await useCase.execute(makeInput());
    expect(logger.warn).toHaveBeenCalledWith(
      'Exchange cancel failed (best effort)',
      expect.any(Object),
    );
  });
});
