import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CancelOrderUseCase } from '../src/CancelOrderUseCase.js';
import { PortfolioService } from '../src/services/PortfolioService.js';
import type { CancelOrderDeps, CancelOrderInput } from '../src/CancelOrderUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderRepository, IPortfolioStore, IExchangeClient, IOrderStateStore, IKeyedMutex, InFlightFill, CancelOrderResult } from '@polymarket/ports';
import { VersionConflictError, pendingMatchFillId } from '@polymarket/ports';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { AccountId, InstrumentId, OrderId } from '@polymarket/ids';
import { asPolymarketCtfToken } from '@polymarket/ids';
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
  };
}

function makeKeyedMutex(): IKeyedMutex {
  return {
    runExclusive: jest.fn(<T>(_keys: readonly string[], fn: () => Promise<T>) => fn()) as unknown as IKeyedMutex['runExclusive'],
  };
}

function makeExchangeClient(success = true): IExchangeClient {
  return {
    submitOrder: jest.fn<IExchangeClient['submitOrder']>().mockResolvedValue(
      Ok({ status: 'OPEN', orderId: ORDER_ID, effectiveSize: makeQty('100'), remainingSize: makeQty('100') }),
    ),
    cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(
      success ? Ok({ status: 'CANCELLED' } as CancelOrderResult) : Err(new TradingError('Exchange error') as never),
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
  let keyedMutex: IKeyedMutex;
  let deps: CancelOrderDeps;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    const order = makeOpenOrder();
    orderRepo = makeOrderRepo(order);
    orderStateStore = makeOrderStateStore(order);
    portfolioStore = makePortfolioStore();
    exchangeClient = makeExchangeClient(true);
    keyedMutex = makeKeyedMutex();

    const portfolioService = new PortfolioService(portfolioStore, logger);

    deps = {
      portfolioService,
      orderRepo,
      orderStateStore,
      keyedMutex,
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

  // ── CAS конфликт при сохранении отменённого ордера ────────────────────────

  describe('save version conflict (CAS)', () => {
    let storePortfolio: Portfolio;

    /** Настраивает deps так, что CAS save конфликтует, а reread возвращает latest */
    function setupConflict(latest: Order | undefined): void {
      const openOrder = makeOpenOrder();
      orderRepo = {
        ...makeOrderRepo(openOrder),
        save: jest.fn<IOrderRepository['save']>().mockResolvedValue(
          Err(new VersionConflictError(String(ORDER_ID), 1, 2)),
        ),
        get: jest.fn<IOrderRepository['get']>()
          .mockResolvedValueOnce(openOrder) // preflight lookup (вне lock)
          .mockResolvedValue(latest),       // reread после конфликта
        getWithVersion: jest.fn<IOrderRepository['getWithVersion']>()
          .mockResolvedValue({ order: openOrder, version: 1 }), // свежий snapshot внутри lock
      } as unknown as IOrderRepository;

      storePortfolio = makePortfolioMock();
      portfolioStore = makePortfolioStore(storePortfolio);
      const portfolioService = new PortfolioService(portfolioStore, logger);
      deps = { ...deps, orderRepo, portfolioService };
    }

    it('reread: ордер терминальный → Ok no-op, без release/exchange cancel/publish', async () => {
      const cancelledLatest = makeOpenOrder().cancel();
      if (!cancelledLatest.ok) throw new Error('cancel failed');
      cancelledLatest.value.pullEvents();
      setupConflict(cancelledLatest.value);

      const useCase = new CancelOrderUseCase(deps);
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(storePortfolio.releaseReservation).not.toHaveBeenCalled();
      expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
      expect(eventBus.publishAll).not.toHaveBeenCalled();
    });

    it('reread: ордер исчез → Ok no-op с warn, без release', async () => {
      setupConflict(undefined);

      const useCase = new CancelOrderUseCase(deps);
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/disappeared/i),
        expect.any(Object),
      );
      expect(storePortfolio.releaseReservation).not.toHaveBeenCalled();
    });

    it('reread: ордер не терминальный → Err, без release/publish', async () => {
      setupConflict(makeOpenOrder());

      const useCase = new CancelOrderUseCase(deps);
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(TradingError);
        expect(result.error.message).toMatch(/version conflict/i);
      }
      expect(storePortfolio.releaseReservation).not.toHaveBeenCalled();
      expect(eventBus.publishAll).not.toHaveBeenCalled();
    });
  });

  // ── Ордер не найден ───────────────────────────────────────────────────────

  it('возвращает Err если ордер не найден', async () => {
    orderRepo = makeOrderRepo(undefined);
    const useCase = new CancelOrderUseCase({ ...deps, orderRepo });
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
    const useCase = new CancelOrderUseCase({ ...deps, orderRepo });
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
    const useCase = new CancelOrderUseCase({ ...deps, orderRepo });
    await useCase.execute(makeInput());
    // Для терминального ордера не вызываем cancelOrder
    expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
  });

  // ── MATCHED на бирже ─────────────────────────────────────────────────────

  it('возвращает Ok без отмены если ордер MATCHED на бирже', async () => {
    orderStateStore = makeOrderStateStore(makeOpenOrder(), [String(ORDER_ID)]);
    const useCase = new CancelOrderUseCase({ ...deps, orderStateStore });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
  });

  it('не отменяет MATCHED ордер локально (orderRepo.save не вызывается)', async () => {
    orderStateStore = makeOrderStateStore(makeOpenOrder(), [String(ORDER_ID)]);
    const useCase = new CancelOrderUseCase({ ...deps, orderStateStore });
    await useCase.execute(makeInput());
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  // ── In-flight fills на инструменте ────────────────────────────────────────

  it('возвращает Ok без отмены, если у инструмента есть in-flight fill (даже если ордер не matched)', async () => {
    // instrumentId для ASSET_ID = asPolymarketCtfToken('123') → InstrumentId '123'
    orderStateStore = makeOrderStateStore(makeOpenOrder(), [], ['123']);
    const useCase = new CancelOrderUseCase({ ...deps, orderStateStore });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    expect(exchangeClient.cancelOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  it('не блокирует cancel для инструмента без in-flight fills', async () => {
    orderStateStore = makeOrderStateStore(makeOpenOrder(), [], ['some-other-instrument']);
    const useCase = new CancelOrderUseCase({ ...deps, orderStateStore });
    const result = await useCase.execute(makeInput());
    expect(result.ok).toBe(true);
    expect(exchangeClient.cancelOrder).toHaveBeenCalled();
  });

  // ── Конкурентность: keyed mutex ───────────────────────────────────────────

  it('сериализует конкурентные execute() для одного orderId через keyedMutex.runExclusive', async () => {
    const callOrder: string[] = [];
    const realMutexKeys: string[][] = [];
    keyedMutex = {
      runExclusive: jest.fn(async (keys: readonly string[], fn: () => Promise<unknown>) => {
        realMutexKeys.push([...keys]);
        callOrder.push('acquire');
        const result = await fn();
        callOrder.push('release');
        return result;
      }),
    } as unknown as IKeyedMutex;

    const useCase = new CancelOrderUseCase({ ...deps, keyedMutex });
    await useCase.execute(makeInput());

    expect(keyedMutex.runExclusive).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['acquire', 'release']);
    // Ключ блокировки включает accountId, orderId, instrumentId
    expect(realMutexKeys[0]).toContain(String(ORDER_ID));
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

  // ── CancelOrderResult (структурированный биржевой исход) ───────────────────

  describe('CancelOrderResult от биржи', () => {
    function withExchangeCancelResult(result: CancelOrderResult): IExchangeClient {
      return {
        ...makeExchangeClient(true),
        cancelOrder: jest.fn<IExchangeClient['cancelOrder']>().mockResolvedValue(Ok(result)),
      };
    }

    it('Ok({status: CANCELLED}) — обычный успех, не помечает matched', async () => {
      exchangeClient = withExchangeCancelResult({ status: 'CANCELLED' });
      const useCase = new CancelOrderUseCase({ ...deps, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(orderStateStore.markOrderFillMatched).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Order cancelled successfully', expect.any(Object));
    });

    it('Ok({status: ALREADY_FILLED}) — помечает markOrderFillMatched и возвращает Ok', async () => {
      exchangeClient = withExchangeCancelResult({ status: 'ALREADY_FILLED', reason: 'matched' });
      const useCase = new CancelOrderUseCase({ ...deps, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(orderStateStore.markOrderFillMatched).toHaveBeenCalledWith(
        ORDER_ID,
        pendingMatchFillId(ORDER_ID),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'Cancel rejected — order was matched on exchange, awaiting fill via WS/reconciliation',
        expect.any(Object),
      );
    });

    it('Ok({status: ALREADY_CANCELLED}) — Ok, не помечает matched', async () => {
      exchangeClient = withExchangeCancelResult({ status: 'ALREADY_CANCELLED' });
      const useCase = new CancelOrderUseCase({ ...deps, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(orderStateStore.markOrderFillMatched).not.toHaveBeenCalled();
    });

    it('Ok({status: NOT_FOUND}) — Ok, не помечает matched', async () => {
      exchangeClient = withExchangeCancelResult({ status: 'NOT_FOUND' });
      const useCase = new CancelOrderUseCase({ ...deps, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(orderStateStore.markOrderFillMatched).not.toHaveBeenCalled();
    });

    it('Ok({status: UNKNOWN_RETRY_NEEDED}) — Ok, логирует error без парсинга текста', async () => {
      exchangeClient = withExchangeCancelResult({ status: 'UNKNOWN_RETRY_NEEDED', reason: 'weird reason' });
      const useCase = new CancelOrderUseCase({ ...deps, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(orderStateStore.markOrderFillMatched).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'EXCHANGE_CANCEL_UNKNOWN_RETRY_NEEDED — venue cancel outcome unclear',
        expect.any(Object),
      );
    });

    it('Err(ExchangeError) — best-effort Ok после локальной отмены, без message.toLowerCase()', async () => {
      exchangeClient = makeExchangeClient(false);
      const useCase = new CancelOrderUseCase({ ...deps, exchangeClient });
      const result = await useCase.execute(makeInput());

      expect(result.ok).toBe(true);
      expect(orderStateStore.markOrderFillMatched).not.toHaveBeenCalled();
    });
  });
});
