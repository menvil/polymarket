import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { UpdateOrderStatusUseCase } from '../src/UpdateOrderStatusUseCase.js';
import { PortfolioService } from '../src/services/PortfolioService.js';
import type { UpdateOrderStatusDeps } from '../src/UpdateOrderStatusUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderRepository, IPortfolioStore, IOrderStateStore } from '@polymarket/ports';
import { VersionConflictError } from '@polymarket/ports';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { AccountId, AssetId, OrderId } from '@polymarket/ids';
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

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;
const ASSET_ID = 'token-abc' as unknown as AssetId;
const ORDER_ID = 'order-1' as unknown as OrderId;
const MOCK_TIMESTAMP = { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '' } as never;

function makeOpenOrder(id: OrderId = ORDER_ID, side: 'BUY' | 'SELL' = 'BUY'): Order {
  const result = Order.create({
    id,
    asset: ASSET_ID,
    side,
    price: Price.of(new Decimal('0.65')) as never,
    size: Quantity.of(new Decimal('100')) as never,
    timestamp: MOCK_TIMESTAMP,
  });
  if (!result.ok) throw result.error;
  const accepted = result.value.accept();
  if (!accepted.ok) throw accepted.error;
  accepted.value.pullEvents();
  return accepted.value;
}

function makeOrderRepo(order: Order | undefined): IOrderRepository {
  return {
    get: jest.fn<IOrderRepository['get']>().mockResolvedValue(order),
    getVersion: jest.fn<IOrderRepository['getVersion']>().mockResolvedValue(order ? 1 : 0),
    getWithVersion: jest.fn<IOrderRepository['getWithVersion']>().mockResolvedValue(
      order ? { order, version: 1 } : undefined,
    ),
    save: jest.fn<IOrderRepository['save']>().mockResolvedValue(Ok(undefined)),
    deleteIfVersion: jest.fn<IOrderRepository['deleteIfVersion']>().mockResolvedValue(Ok({ status: 'DELETED' })),
    deleteIfState: jest.fn<IOrderRepository['deleteIfState']>().mockResolvedValue(Ok({ status: 'DELETED' })),
    getAll: jest.fn<IOrderRepository['getAll']>().mockResolvedValue([]),
    clear: jest.fn(),
  } as unknown as IOrderRepository;
}

function makeOrderStateStore(storedOrder?: Order): IOrderStateStore {
  return {
    getOrder: jest.fn().mockReturnValue(storedOrder),
    hasMatchedFills: jest.fn().mockReturnValue(false),
    markOrderFillMatched: jest.fn(),
    clearOrderFillMatched: jest.fn(),
    getMatchedFillIds: jest.fn().mockReturnValue([]),
    getOpenOrdersByInstrument: jest.fn().mockReturnValue([]),
    hasInFlightFills: jest.fn().mockReturnValue(false),
    clearInFlightFill: jest.fn(),
    markInFlightFill: jest.fn(),
    getInFlightFills: jest.fn().mockReturnValue([]),
  } as unknown as IOrderStateStore;
}

function makePortfolioStore(): IPortfolioStore {
  const portfolio = {
    accountId: ACCOUNT_ID,
    balance: {
      reserved: new Decimal(0),
      available: new Decimal(1000),
    },
    positions: new Map() as ReadonlyMap<string, IPosition>,
    version: 0,
  } as unknown as Portfolio;
  // Release теперь вызывается после успешного CAS save (см. UpdateOrderStatusUseCase шаг 5)
  (portfolio as { releaseReservation?: unknown }).releaseReservation =
    jest.fn().mockReturnValue(Ok(portfolio));
  (portfolio as { releaseTokenReservation?: unknown }).releaseTokenReservation =
    jest.fn().mockReturnValue(Ok(portfolio));

  return {
    get: jest.fn<IPortfolioStore['get']>().mockReturnValue(portfolio),
    save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
    getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('UpdateOrderStatusUseCase', () => {
  let logger: ILogger;
  let eventBus: IEventBus;
  let portfolioStore: IPortfolioStore;
  let orderRepo: IOrderRepository;
  let orderStateStore: IOrderStateStore;
  let portfolioService: PortfolioService;
  let deps: UpdateOrderStatusDeps;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    portfolioStore = makePortfolioStore();
    portfolioService = new PortfolioService(portfolioStore, logger);
  });

  it('возвращает Ok(void) если ордер не найден (не крашит)', async () => {
    orderRepo = makeOrderRepo(undefined);
    orderStateStore = makeOrderStateStore();
    deps = { orderRepo, orderStateStore, portfolioService, eventBus, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'ACCEPTED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });
    expect(result.ok).toBe(true);
  });

  it('ACCEPTED → сохраняет Order и публикует события', async () => {
    // Order уже OPEN — нужен PENDING order для ACCEPTED
    const pendingResult = Order.create({
      id: ORDER_ID,
      asset: ASSET_ID,
      side: 'BUY',
      price: Price.of(new Decimal('0.65')) as never,
      size: Quantity.of(new Decimal('100')) as never,
      timestamp: MOCK_TIMESTAMP,
    });
    if (!pendingResult.ok) throw pendingResult.error;
    const pendingOrder = pendingResult.value;
    pendingOrder.pullEvents();

    orderRepo = makeOrderRepo(pendingOrder);
    orderStateStore = makeOrderStateStore(pendingOrder);
    deps = { orderRepo, orderStateStore, portfolioService, eventBus, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'ACCEPTED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(orderRepo.save).toHaveBeenCalled();
    expect(eventBus.publishAll).toHaveBeenCalled();
  });

  it('CANCELLED на OPEN ордере → Ok(void), save вызван', async () => {
    const order = makeOpenOrder();
    orderRepo = makeOrderRepo(order);
    orderStateStore = makeOrderStateStore(order);
    deps = { orderRepo, orderStateStore, portfolioService, eventBus, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(orderRepo.save).toHaveBeenCalled();
  });

  it('CANCELLED на уже CANCELED ордере → Ok(void), idempotent (save не вызван)', async () => {
    const order = makeOpenOrder();
    const cancelResult = order.cancel();
    if (!cancelResult.ok) throw cancelResult.error;
    const cancelledOrder = cancelResult.value;
    cancelledOrder.pullEvents();

    orderRepo = makeOrderRepo(cancelledOrder);
    orderStateStore = makeOrderStateStore(cancelledOrder);
    deps = { orderRepo, orderStateStore, portfolioService, eventBus, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(orderRepo.save).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringMatching(/duplicate/i),
      expect.any(Object),
    );
  });

  it('ACCEPTED на терминальном ордере → Ok(void), логирует warn (cancel/fill race)', async () => {
    const order = makeOpenOrder();
    const cancelResult = order.cancel();
    if (!cancelResult.ok) throw cancelResult.error;
    const cancelledOrder = cancelResult.value;
    cancelledOrder.pullEvents();

    orderRepo = makeOrderRepo(cancelledOrder);
    orderStateStore = makeOrderStateStore(cancelledOrder);
    deps = { orderRepo, orderStateStore, portfolioService, eventBus, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'ACCEPTED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/already terminal/i),
      expect.any(Object),
    );
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  it('CAS conflict + latest несовместим (не терминален, не целевой статус) → Err, release/publish не вызваны', async () => {
    const order = makeOpenOrder();
    orderRepo = {
      ...makeOrderRepo(order),
      save: jest.fn<IOrderRepository['save']>().mockResolvedValue(
        Err(new VersionConflictError(String(ORDER_ID), 1, 2)),
      ),
      // reread возвращает всё тот же OPEN ордер — конфликт «неразрешим» здесь
      get: jest.fn<IOrderRepository['get']>().mockResolvedValue(order),
    } as unknown as IOrderRepository;
    orderStateStore = makeOrderStateStore(order);
    deps = { orderRepo, orderStateStore, portfolioService, eventBus, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(TradingError);
    }
    expect(eventBus.publishAll).not.toHaveBeenCalled();
    const portfolio = (portfolioStore.get as jest.Mock)(ACCOUNT_ID) as Portfolio;
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
  });

  it('CAS conflict (concurrent fill): reread терминальный ордер → Ok, release/publish не вызваны', async () => {
    const order = makeOpenOrder();
    // Simulate: fill применился (saveSync) между чтением версии и CAS save → FILLED в repo
    const filledOrder = { ...order, status: 'FILLED', isTerminal: true } as unknown as Order;
    orderRepo = {
      ...makeOrderRepo(order), // getWithVersion (шаг 1) снимает snapshot ДО конфликта
      save: jest.fn<IOrderRepository['save']>().mockResolvedValue(
        Err(new VersionConflictError(String(ORDER_ID), 1, 2)),
      ),
      get: jest.fn<IOrderRepository['get']>().mockResolvedValue(filledOrder), // reread после конфликта
    } as unknown as IOrderRepository;
    orderStateStore = makeOrderStateStore(filledOrder);
    deps = { orderRepo, orderStateStore, portfolioService, eventBus, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/version conflict/i),
      expect.any(Object),
    );
    expect(eventBus.publishAll).not.toHaveBeenCalled();
    const portfolio = (portfolioStore.get as jest.Mock)(ACCOUNT_ID) as Portfolio;
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
  });

  it('CAS conflict: latest уже в целевом статусе (дубль-событие) → Ok no-op', async () => {
    const order = makeOpenOrder();
    const cancelResult = order.cancel();
    if (!cancelResult.ok) throw cancelResult.error;
    const cancelledLatest = cancelResult.value;
    cancelledLatest.pullEvents();

    const openOrder = makeOpenOrder();
    orderRepo = {
      ...makeOrderRepo(openOrder), // getWithVersion (шаг 1) снимает snapshot ДО конфликта
      save: jest.fn<IOrderRepository['save']>().mockResolvedValue(
        Err(new VersionConflictError(String(ORDER_ID), 1, 2)),
      ),
      get: jest.fn<IOrderRepository['get']>().mockResolvedValue(cancelledLatest), // reread: уже CANCELED
    } as unknown as IOrderRepository;
    orderStateStore = makeOrderStateStore(cancelledLatest);
    deps = { orderRepo, orderStateStore, portfolioService, eventBus, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(eventBus.publishAll).not.toHaveBeenCalled();
  });
});
